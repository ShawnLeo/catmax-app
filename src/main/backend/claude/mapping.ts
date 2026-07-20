/**
 * Claude stream-json message → TurnEvent 转译层。
 *
 * Claude 的内容块（content blocks）模型：
 * - text → text_delta（累积）
 * - thinking → reasoning_delta
 * - tool_use → tool_call_started
 * - tool_result（在后续 user 消息里）→ tool_call_completed
 *
 * 两种消息来源：
 * 1. `assistant`（完整块，无 --include-partial-messages 时）—— assistantToEvents
 * 2. `stream_event`（带 --include-partial-messages 时，逐 token delta）—— 用 StreamEventAggregator
 *    这是真正的流式：claude 把每个 token 增量包成 content_block_delta 推过来。
 */
import { randomUUID } from 'node:crypto'

import type {
  AssistantMessage,
  ContentBlock,
  ResultMessage,
  StreamContentBlock,
  StreamDelta,
  StreamEventMessage,
  TextContent,
  ThinkingContent,
  ToolResultContent,
  ToolUseContent,
} from '@shared/backend/claude-schema'
import type { ToolCallInfo, ToolOutput, TurnEvent } from '@shared/backend/types'

/** 把 claude 的 tool_use 映射到 ToolCallInfo */
export function toolUseToInfo(block: ToolUseContent): ToolCallInfo {
  const input = block.input as Record<string, unknown> | undefined
  switch (block.name) {
    case 'Bash':
      return {
        kind: 'shell_command',
        title: typeof input?.command === 'string' ? input.command.slice(0, 80) : block.name,
        detail: typeof input?.command === 'string' ? input.command : JSON.stringify(input),
      }
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return {
        kind: 'file_edit',
        title:
          typeof input?.file_path === 'string' ? `${block.name}: ${input.file_path}` : block.name,
        detail: JSON.stringify(input, null, 2),
      }
    case 'Read':
    case 'Glob':
    case 'Grep':
      return {
        kind: 'file_read',
        title:
          typeof input?.file_path === 'string' ? `${block.name}: ${input.file_path}` : block.name,
        detail: JSON.stringify(input, null, 2),
      }
    default:
      // MCP tools 形如 mcp__server__tool
      if (block.name.startsWith('mcp__')) {
        return {
          kind: 'mcp',
          title: block.name,
          detail: JSON.stringify(input, null, 2),
        }
      }
      return {
        kind: 'other',
        title: block.name,
        detail: JSON.stringify(input, null, 2),
      }
  }
}

/** 把 claude 的 tool_result 内容块映射到 ToolOutput */
export function toolResultToOutput(block: ToolResultContent): ToolOutput {
  const isError = block.is_error === true
  let output: string | undefined
  if (typeof block.content === 'string') {
    output = block.content
  } else if (Array.isArray(block.content)) {
    // content 可能是 [{type: 'text', text: '...'}]
    output = block.content
      .map((c: unknown) =>
        typeof c === 'object' && c !== null && 'text' in c
          ? String((c as { text: unknown }).text)
          : String(c),
      )
      .join('\n')
  }

  return {
    ok: !isError,
    summary: isError ? 'failed' : 'completed',
    ...(output !== undefined ? { output } : {}),
  }
}

/** 从 assistant 消息提取事件序列 */
export function* assistantToEvents(msg: AssistantMessage, turnId: string): Iterable<TurnEvent> {
  for (const block of msg.message.content) {
    const itemId = blockId(block)
    switch (block.type) {
      case 'text': {
        const text = (block as TextContent).text
        yield { type: 'text_delta', turnId, itemId, text }
        break
      }
      case 'thinking': {
        const text = (block as ThinkingContent).thinking
        yield { type: 'reasoning_delta', turnId, itemId, text }
        break
      }
      case 'tool_use': {
        const tool = toolUseToInfo(block as ToolUseContent)
        yield { type: 'tool_call_started', turnId, itemId, tool }
        break
      }
      // tool_result 在 user 消息里，不在这里处理
      default:
        break
    }
  }
}

/** 从 user 消息（含 tool_result）提取 tool_call_completed 事件 */
export function* userToolResultToEvents(
  msg: { message: { content: ContentBlock[] } },
  turnId: string,
): Iterable<TurnEvent> {
  for (const block of msg.message.content) {
    if (block.type === 'tool_result') {
      const result = block as ToolResultContent
      const itemId = result.tool_use_id
      yield {
        type: 'tool_call_completed',
        turnId,
        itemId,
        output: toolResultToOutput(result),
      }
    }
  }
}

/** result 消息 → turn_completed 事件 */
export function resultToEvent(msg: ResultMessage, turnId: string): TurnEvent {
  const status: 'completed' | 'interrupted' | 'error' = msg.is_error
    ? 'error'
    : msg.subtype === 'interrupted'
      ? 'interrupted'
      : 'completed'
  const usage = msg.usage
    ? {
        ...(msg.usage.input_tokens !== undefined ? { inputTokens: msg.usage.input_tokens } : {}),
        ...(msg.usage.output_tokens !== undefined ? { outputTokens: msg.usage.output_tokens } : {}),
        ...(msg.usage.cache_read_input_tokens !== undefined
          ? { cacheReadTokens: msg.usage.cache_read_input_tokens }
          : {}),
        ...(msg.total_cost_usd !== undefined ? { costUsd: msg.total_cost_usd } : {}),
      }
    : undefined
  return {
    type: 'turn_completed',
    turnId,
    status,
    ...(usage !== undefined ? { usage } : {}),
  }
}

/** content block 取 id（tool_use 有 id，其他生成） */
function blockId(block: ContentBlock): string {
  if (block.type === 'tool_use') {
    return (block as ToolUseContent).id
  }
  return randomUUID()
}

// ============ stream_event 流式增量处理 ============
//
// 加了 --include-partial-messages 后，claude 把每个 token 包成 stream_event 推过来。
// 协议（Anthropic Messages API streaming）：
//   message_start
//   content_block_start { index: 0, content_block: { type: 'thinking'|'text'|'tool_use', ... } }
//   content_block_delta { index: 0, delta: { type: 'thinking_delta'|'text_delta'|'input_json_delta', ... } }
//   ... 多个 delta
//   content_block_stop  { index: 0 }
//   message_delta / message_stop
//
// 我们要做的：
// - 维护 block index → block 类型 + id 的映射（content_block_start 时建立）
// - text_delta → push text_delta TurnEvent
// - thinking_delta → push reasoning_delta TurnEvent
// - tool_use 的 input_json_delta：累积 partial_json，content_block_stop 时一次性发 tool_call_started
//   （因为 tool_use 的 input 是结构化 JSON，没法逐 token 显示给用户）

/** 单个 block 的流式追踪状态 */
interface StreamingBlock {
  type: string // 'text' | 'thinking' | 'tool_use' | ...
  /** block 的稳定 id（同一个 block 的所有 delta 共用）—— text/thinking 没有自带 id 时随机生成 */
  itemId: string
  /** tool_use 累积的 partial_json（input_json_delta 拼起来） */
  toolInputJsonBuffer: string
  /** tool_use 元数据（content_block_start 时记下，可能为 undefined 表示不是 tool_use 块） */
  toolName?: string | undefined
}

/**
 * 流式事件聚合器：维护 block 状态机，把 stream_event 转 TurnEvent。
 *
 * 使用：每个 turn new 一个，stream_event 消息到了调 push()，拿返回的 events 推给 UI。
 * turn 结束（result 消息或进程退出）后调 flushPendingToolUse() 兜底发出未 stop 的 tool。
 */
export class StreamEventAggregator {
  private blocks = new Map<number, StreamingBlock>()
  /** 已经发过 tool_call_started 的 itemId（防止重复发） */
  private firedToolStarts = new Set<string>()

  constructor(private readonly turnId: string) {}

  /**
   * 处理一条 stream_event 消息，返回要 push 给 UI 的 TurnEvent 列表。
   * 不是所有 event 都会产生 TurnEvent（比如 message_start 直接被忽略）。
   */
  push(streamMsg: StreamEventMessage): TurnEvent[] {
    const ev = streamMsg.event
    const out: TurnEvent[] = []
    switch (ev.type) {
      case 'content_block_start': {
        const idx = ev.index ?? 0
        const cb = ev.content_block
        if (cb) {
          this.blocks.set(idx, this.initBlock(cb))
        }
        break
      }
      case 'content_block_delta': {
        const idx = ev.index ?? 0
        const block = this.blocks.get(idx)
        if (!block || !ev.delta) break
        const event = this.deltaToEvent(block, ev.delta)
        if (event) out.push(event)
        break
      }
      case 'content_block_stop': {
        const idx = ev.index ?? 0
        const block = this.blocks.get(idx)
        if (block && block.type === 'tool_use' && !this.firedToolStarts.has(block.itemId)) {
          // tool_use 块结束——累积的 partial_json 是完整 input，发 tool_call_started
          out.push(this.buildToolCallStarted(block))
          this.firedToolStarts.add(block.itemId)
        }
        this.blocks.delete(idx)
        break
      }
      // message_start / message_delta / message_stop / ping 等不产生 UI 事件
      default:
        break
    }
    return out
  }

  /** turn 结束时调用——把还没收到 content_block_stop 的 tool_use 兜底发出 */
  flushPendingToolUse(): TurnEvent[] {
    const out: TurnEvent[] = []
    for (const block of this.blocks.values()) {
      if (block.type === 'tool_use' && !this.firedToolStarts.has(block.itemId)) {
        out.push(this.buildToolCallStarted(block))
        this.firedToolStarts.add(block.itemId)
      }
    }
    this.blocks.clear()
    return out
  }

  private initBlock(cb: StreamContentBlock): StreamingBlock {
    // tool_use 块带 id（claude/anthropic 的 tool_use id），用它的；
    // text/thinking 没有 id，随机生成一个（同一个 block 后续 delta 共用）
    const itemId = cb.id ?? randomUUID()
    return {
      type: cb.type,
      itemId,
      toolInputJsonBuffer: '',
      toolName: cb.name,
    }
  }

  private deltaToEvent(block: StreamingBlock, delta: StreamDelta): TurnEvent | null {
    const dt = (delta as { type: string }).type
    if (dt === 'text_delta') {
      const text = (delta as { text?: string }).text ?? ''
      if (!text) return null
      return { type: 'text_delta', turnId: this.turnId, itemId: block.itemId, text }
    }
    if (dt === 'thinking_delta') {
      const text = (delta as { thinking?: string }).thinking ?? ''
      if (!text) return null
      return { type: 'reasoning_delta', turnId: this.turnId, itemId: block.itemId, text }
    }
    if (dt === 'input_json_delta') {
      // tool_use 的 input 是 JSON 字符串，分块到达——累积，等 content_block_stop
      const partial = (delta as { partial_json?: string }).partial_json ?? ''
      block.toolInputJsonBuffer += partial
      return null
    }
    // 未知 delta 类型（签名_delta 等）忽略
    return null
  }

  private buildToolCallStarted(block: StreamingBlock): TurnEvent {
    let input: unknown = {}
    if (block.toolInputJsonBuffer) {
      try {
        input = JSON.parse(block.toolInputJsonBuffer)
      } catch {
        // partial_json 不完整（极端情况）——保留原始字符串
        input = { _raw: block.toolInputJsonBuffer }
      }
    }
    // 复用 toolUseToInfo 的映射逻辑（Bash → shell_command, Edit → file_edit 等）
    const info = toolUseToInfo({
      type: 'tool_use',
      id: block.itemId,
      name: block.toolName ?? 'unknown',
      input,
    })
    return {
      type: 'tool_call_started',
      turnId: this.turnId,
      itemId: block.itemId,
      tool: info,
    }
  }
}
