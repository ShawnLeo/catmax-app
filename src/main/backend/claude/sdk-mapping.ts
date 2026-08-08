/**
 * Claude Agent SDK message → TurnEvent 转译层。
 *
 * 这是 CLI 时代 mapping.ts 的 SDK 版本。SDK 的 SDKMessage 与 CLI 的 stream-json
 * 消息结构同构（都包装 Anthropic Messages API），所以核心映射逻辑（toolUseToInfo 等）
 * 直接复用自 ./mapping.ts，只把输入类型从 zod 推断的 CLI schema 换成 SDK 的 typed 消息。
 *
 * 两种 SDK 消息来源（对应 CLI 的两种）：
 * 1. SDKAssistantMessage（完整块）→ sdkAssistantToEvents（对应 assistantToEvents）
 * 2. SDKPartialAssistantMessage（逐 token delta，type 仍叫 'stream_event'）
 *    → SdkPartialAggregator（对应 StreamEventAggregator，但 SDK 已给 typed 事件，更简单）
 *
 * 注意：不从 @anthropic-ai/sdk 直接导入 Beta 类型（它是 claude-agent-sdk 的传递依赖，
 * pnpm 结构下 TS 解析不到）。用 SDK 自身类型推导的索引类型代替。
 */
import { randomUUID } from 'node:crypto'

import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { NormalizedMessage, TokenUsage, ToolCallInfo, TurnEvent } from '@shared/backend/types'

import { toolResultToOutput, toolUseResultToStats, toolUseToInfo } from './mapping'

// ============ 局部类型：从 SDK 类型推导 content block 形状，避免直接引用 @anthropic-ai/sdk ============

/** SDK assistant message 的 content block（联合，含 text/thinking/tool_use/...） */
type SdkContentBlock = SDKAssistantMessage['message']['content'][number]

/** tool_use block 的结构（从联合里 narrowing 出来） */
interface SdkToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

/** tool_result block 的结构（user message 里） */
interface SdkToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content?: unknown
  is_error?: boolean
}

// ============ 类型适配：把 SDK 的 content block 桥接到 mapping.ts 认识的形状 ============

/** SDK tool_use block → mapping.ts 的 ToolUseContent 形状 */
function sdkToToolUse(block: SdkToolUseBlock): Parameters<typeof toolUseToInfo>[0] {
  return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
}

/** SDK tool_result block → mapping.ts 的 ToolResultContent 形状 */
function sdkToToolResult(block: SdkToolResultBlock): Parameters<typeof toolResultToOutput>[0] {
  return {
    type: 'tool_result',
    tool_use_id: block.tool_use_id,
    content: block.content as string | unknown[] | undefined,
    is_error: block.is_error,
  }
}

// ============ SDK 消息 → TurnEvent ============

/**
 * 从 SDKAssistantMessage 提取事件序列。
 *
 * 对应 CLI 时代的 assistantToEvents。includePartialMessages: true 时走 partial 路径，
 * 这个函数主要用于非 partial 模式或作为兜底。
 */
export function* sdkAssistantToEvents(
  msg: SDKAssistantMessage,
  turnId: string,
): Iterable<TurnEvent> {
  // Message Grouping: 整条 API 消息共享一个 messageId，renderer 据此把 thinking /
  // 正文 / 多个 tool_use 聚到一条 NormalizedMessage 上——与历史回放按 message.id
  // 归组的口径一致。
  const messageId = msg.message.id
  for (const block of msg.message.content) {
    const itemId = sdkBlockId(block)
    switch (block.type) {
      case 'text': {
        const text = (block as { text: string }).text
        yield { type: 'text_delta', turnId, itemId, text, messageId }
        break
      }
      case 'thinking': {
        const text = (block as { thinking: string }).thinking
        yield { type: 'reasoning_delta', turnId, itemId, text, messageId }
        break
      }
      case 'tool_use': {
        const toolUse = block as unknown as SdkToolUseBlock
        const tool: ToolCallInfo = toolUseToInfo(sdkToToolUse(toolUse))
        yield { type: 'tool_call_started', turnId, itemId, tool, messageId }
        break
      }
      default:
        break
    }
  }
}

/**
 * 子 Agent 内部消息 → 事件。
 *
 * 与 sdkAssistantToEvents 的区别不只是加个前缀：主对话流是 delta 累积的
 * （text_delta 逐 token 追加），而子 Agent 走的是完整消息转发，没有 partial 流，
 * 所以这里产出的是成型的 NormalizedMessage，由 renderer 按 id 合并。
 *
 * 返回空数组表示这条消息没有可渲染内容（例如只有 SDK 内部块），调用方直接丢弃。
 */
export function sdkSubagentToEvents(
  msg: SDKAssistantMessage | SDKUserMessage,
  turnId: string,
  parentToolUseId: string,
): TurnEvent[] {
  const events: TurnEvent[] = []
  const content = (msg.message as { content: unknown }).content
  if (!Array.isArray(content)) return events

  if (msg.type === 'user') {
    // 子 Agent 内部的工具结果——回填到它自己的工具块上。
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      if ((block as { type?: string }).type !== 'tool_result') continue
      const result = block as SdkToolResultBlock
      events.push({
        type: 'subagent_tool_result',
        turnId,
        parentToolUseId,
        toolUseId: result.tool_use_id,
        output: toolResultToOutput(sdkToToolResult(result)),
      })
    }
    return events
  }

  const textBlocks: NonNullable<NormalizedMessage['textBlocks']> = []
  const toolBlocks: NonNullable<NormalizedMessage['toolBlocks']> = []
  for (const block of content as SdkContentBlock[]) {
    switch (block.type) {
      case 'text': {
        const text = (block as { text: string }).text
        if (text) textBlocks.push({ id: sdkBlockId(block), text, kind: 'text' })
        break
      }
      case 'thinking': {
        const text = (block as { thinking: string }).thinking
        if (text) textBlocks.push({ id: sdkBlockId(block), text, kind: 'reasoning' })
        break
      }
      case 'tool_use': {
        const toolUse = block as unknown as SdkToolUseBlock
        toolBlocks.push({
          id: toolUse.id,
          info: toolUseToInfo(sdkToToolUse(toolUse)),
          status: 'running',
          startedAt: Date.now(),
        })
        break
      }
      default:
        break
    }
  }
  if (textBlocks.length === 0 && toolBlocks.length === 0) return events

  events.push({
    type: 'subagent_message',
    turnId,
    parentToolUseId,
    message: {
      id: msg.message.id,
      role: 'assistant',
      turnId,
      textBlocks,
      toolBlocks,
      createdAt: Date.now(),
    },
  })
  return events
}

/**
 * 从 SDKUserMessage 提取 tool_call_completed 事件。
 *
 * SDK 的 user message 里的 tool_result 块标记上一个 tool_use 完成。
 * tool_use_result 是 Task（子 Agent）完成时附加的统计字段。
 */
export function* sdkUserToolResultToEvents(
  msg: SDKUserMessage,
  turnId: string,
): Iterable<TurnEvent> {
  const content = (msg.message as { content: unknown }).content
  if (!Array.isArray(content)) return
  // Agent/Task 转到后台时，SDK 会立刻返回 async_launched / remote_launched。
  // 这只是启动确认，不是执行完成；真实终态由后续 task_notification 给出。
  if (isAsyncToolLaunch(msg.tool_use_result)) return
  const stats = toolUseResultToStats(msg.tool_use_result)
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    if ((block as { type?: string }).type === 'tool_result') {
      const result = block as SdkToolResultBlock
      const itemId = result.tool_use_id
      yield {
        type: 'tool_call_completed',
        turnId,
        itemId,
        output: toolResultToOutput(sdkToToolResult(result)),
        ...(stats !== undefined ? { taskStats: stats } : {}),
      }
    }
  }
}

function isAsyncToolLaunch(toolUseResult: unknown): boolean {
  if (toolUseResult === null || typeof toolUseResult !== 'object') return false
  const result = toolUseResult as Record<string, unknown>
  return (
    result.status === 'async_launched' ||
    result.status === 'remote_launched' ||
    result.isAsync === true
  )
}

// ============ SdkPartialAggregator：stream_event → TurnEvent 状态机 ============

/** 单个 block 的流式追踪状态 */
interface PartialBlockState {
  type: string
  itemId?: string // tool_use 的 id
  toolName?: string // tool_use 的 name（content_block_start 就有）
  toolInputBuffer?: string // input_json_delta 的累积片段
  /**
   * 这个 block 所属 API 消息的 id（message_start 带来）。
   * 存在 block 上而不是只存一个「当前」值——flushPendingToolUse 是 turn 末尾的兜底，
   * 那时 currentMessageId 已经指向最后一条消息，用它会把早先消息的工具归错组。
   */
  messageId?: string
}

/**
 * SDKPartialAssistantMessage → TurnEvent[]。
 *
 * SDK 的 partial message（type: 'stream_event'）就是 Anthropic Messages API 的流式事件，
 * 与 CLI 的 stream_event 完全相同。tool_use 的 input 仍是逐 delta 累积的 JSON 片段，
 * 需要在 content_block_stop 时才能解析。这是一个轻量状态机，按 content block index 跟踪。
 *
 * ⚠️ itemId 唯一性：Anthropic 流式 API 的 content_block `index` 在【每个 assistant message
 * 内】从 0 重新计数。agentic loop 里一个 turn 有多个 assistant message（think→tool_use，
 * 然后 think→text）。text/thinking 块没有 API id，如果用 `text-${idx}` 生成 itemId，
 * 第二条消息的 text/thinking 会和第一条撞 itemId → 前端把新内容追加进旧块
 *（thinking 串进第一个 thinking 块、Markdown 复用第一个 text 块）。
 * 解法：用单调递增的 blockSeq 给每个块生成全局唯一 itemId；并在 message_start 清空 blocks。
 */
export class SdkPartialAggregator {
  private blocks = new Map<number, PartialBlockState>()
  private firedToolStarts = new Set<string>()
  /** 单调递增序列：给没有 API id 的 block（text/thinking）生成全局唯一 itemId */
  private blockSeq = 0
  /** 当前 API 消息的 id（message_start 写入），见 PartialBlockState.messageId。 */
  private currentMessageId: string | undefined

  constructor(private readonly turnId: string) {}

  /** 喂一条 partial 消息，返回要 emit 的 TurnEvent[] */
  push(msg: SDKPartialAssistantMessage): TurnEvent[] {
    return this.handleStreamEvent(msg.event)
  }

  /** turn 结束时兜底：把还没发 tool_call_started 的 tool_use 补上 */
  flushPendingToolUse(): TurnEvent[] {
    const events: TurnEvent[] = []
    for (const [, block] of this.blocks) {
      if (block.type === 'tool_use' && block.itemId && !this.firedToolStarts.has(block.itemId)) {
        const ev = this.buildToolCallStarted(block)
        if (ev) events.push(ev)
      }
    }
    return events
  }

  // SDK 的 event 类型是 BetaRawMessageStreamEvent（来自 @anthropic-ai/sdk），
  // 这里用结构化的 case 判断，不直接引用该类型。
  private handleStreamEvent(event: SDKPartialAssistantMessage['event']): TurnEvent[] {
    const events: TurnEvent[] = []
    const evt = event as {
      type: string
      index?: number
      message?: { id?: string }
      content_block?: { type: string; id?: string; name?: string }
      delta?: { type: string; text?: string; thinking?: string; partial_json?: string }
    }

    switch (evt.type) {
      case 'message_start': {
        // 新的 assistant message 开始：content_block index 会从 0 重新计数，
        // 清空 blocks 防止旧 entry 被同 index 的新块误命中 / Map 无限增长。
        this.blocks.clear()
        // Message Grouping: 这里是 API 消息边界，也是 renderer 的消息归组边界。
        this.currentMessageId = evt.message?.id
        break
      }
      case 'content_block_start': {
        const idx = evt.index
        const block = evt.content_block
        if (idx === undefined || !block) break
        const entry: PartialBlockState = { type: block.type }
        if (this.currentMessageId !== undefined) entry.messageId = this.currentMessageId
        if (block.type === 'tool_use') {
          // tool_use 有 API 提供的全局唯一 id，直接用
          if (block.id) entry.itemId = block.id
          entry.toolName = block.name ?? ''
          entry.toolInputBuffer = ''
        } else {
          // text/thinking 没有 API id，用单调计数器生成全局唯一 itemId
          //（不能用 idx，因为 idx 跨 message 会重复 → 前端块串流复用）
          entry.itemId = `${block.type}-${this.blockSeq++}`
        }
        this.blocks.set(idx, entry)
        break
      }
      case 'content_block_delta': {
        const idx = evt.index
        const entry = idx !== undefined ? this.blocks.get(idx) : undefined
        if (!entry || !evt.delta) break
        const delta = evt.delta
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          // itemId 在 content_block_start 时已赋值；缺失则跳过（协议上不会发生）
          if (entry.itemId) {
            events.push({
              type: 'text_delta',
              turnId: this.turnId,
              itemId: entry.itemId,
              text: delta.text,
              ...(entry.messageId !== undefined ? { messageId: entry.messageId } : {}),
            })
          }
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          if (entry.itemId) {
            events.push({
              type: 'reasoning_delta',
              turnId: this.turnId,
              itemId: entry.itemId,
              text: delta.thinking,
              ...(entry.messageId !== undefined ? { messageId: entry.messageId } : {}),
            })
          }
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          if (entry.toolInputBuffer !== undefined) {
            entry.toolInputBuffer += delta.partial_json
          }
        }
        break
      }
      case 'content_block_stop': {
        const idx = evt.index
        const entry = idx !== undefined ? this.blocks.get(idx) : undefined
        if (!entry) break
        if (entry.type === 'tool_use' && entry.itemId) {
          const ev = this.buildToolCallStarted(entry)
          if (ev) events.push(ev)
        }
        break
      }
      default:
        break
    }
    return events
  }

  private buildToolCallStarted(entry: PartialBlockState): TurnEvent | null {
    if (!entry.itemId) return null
    if (this.firedToolStarts.has(entry.itemId)) return null
    this.firedToolStarts.add(entry.itemId)

    let input: Record<string, unknown> = {}
    if (entry.toolInputBuffer !== undefined && entry.toolInputBuffer.length > 0) {
      try {
        input = JSON.parse(entry.toolInputBuffer)
      } catch {
        input = { _raw: entry.toolInputBuffer }
      }
    }

    const tool: ToolCallInfo = toolUseToInfo({
      type: 'tool_use',
      id: entry.itemId,
      name: entry.toolName ?? '',
      input,
    })

    return {
      type: 'tool_call_started',
      turnId: this.turnId,
      itemId: entry.itemId,
      tool,
      ...(entry.messageId !== undefined ? { messageId: entry.messageId } : {}),
    }
  }
}

// ============ result / system 消息 ============

/** SDKResultMessage → turn_completed 事件 */
export function sdkResultToEvent(
  msg: SDKResultMessage,
  turnId: string,
  usageOverride?: TokenUsage,
  statusOverride?: 'completed' | 'interrupted' | 'error',
): TurnEvent {
  // SDK 的 result subtype 是 'success' | 'error_during_execution' | ...（没有单纯的 'error' 或 'interrupted'）
  // is_error 才是判断错误的权威字段
  const isErr = msg.is_error
  const status = statusOverride ?? (isErr ? 'error' : 'completed')
  const usage =
    usageOverride ??
    ({
      ...(msg.usage.input_tokens !== undefined ? { inputTokens: msg.usage.input_tokens } : {}),
      ...(msg.usage.output_tokens !== undefined ? { outputTokens: msg.usage.output_tokens } : {}),
      ...(msg.usage.cache_read_input_tokens !== undefined
        ? { cacheReadTokens: msg.usage.cache_read_input_tokens }
        : {}),
      ...(msg.total_cost_usd !== undefined ? { costUsd: msg.total_cost_usd } : {}),
    } satisfies TokenUsage)
  return {
    type: 'turn_completed',
    turnId,
    status,
    usage,
  }
}

/** 提取 SDKSystemMessage 的 session_id（用于 onRealSessionId 回调） */
export function sdkSystemSessionId(msg: SDKSystemMessage): string | undefined {
  return msg.session_id
}

// ============ 类型保护 ============

/** SDK content block 取 id */
function sdkBlockId(block: SdkContentBlock): string {
  if (block.type === 'tool_use') {
    return (block as unknown as SdkToolUseBlock).id
  }
  return randomUUID()
}

/** 判断 SDKMessage 是否是 assistant 消息 */
export function isSdkAssistantMessage(msg: SDKMessage): msg is SDKAssistantMessage {
  return msg.type === 'assistant'
}

/** 判断 SDKMessage 是否是 partial（stream_event）消息 */
export function isSdkPartialMessage(msg: SDKMessage): msg is SDKPartialAssistantMessage {
  return msg.type === 'stream_event'
}

/** 判断 SDKMessage 是否是 user 消息 */
export function isSdkUserMessage(msg: SDKMessage): msg is SDKUserMessage {
  return msg.type === 'user'
}

/** 判断 SDKMessage 是否是 result 消息 */
export function isSdkResultMessage(msg: SDKMessage): msg is SDKResultMessage {
  return msg.type === 'result'
}

/** 判断 SDKMessage 是否是 init system 消息（其他 system subtype 有各自结构）。 */
export function isSdkInitMessage(msg: SDKMessage): msg is SDKSystemMessage {
  return msg.type === 'system' && msg.subtype === 'init'
}
