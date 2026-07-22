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
import type {
  ToolCallInfo,
  ToolOutput,
  ToolTaskStats,
  TurnEvent,
  ApprovalRequest,
} from '@shared/backend/types'

import { assessRisk } from '../shared/assess-risk'

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
    case 'Edit': {
      // Edit: { file_path, old_string, new_string } → 结构化 string_replace
      const fp = typeof input?.file_path === 'string' ? input.file_path : ''
      const oldStr = typeof input?.old_string === 'string' ? input.old_string : ''
      const newStr = typeof input?.new_string === 'string' ? input.new_string : ''
      return {
        kind: 'file_edit',
        title: `Edit: ${fp}`,
        detail: JSON.stringify(input, null, 2), // 保留 fallback（前端优先用 edit）
        ...(oldStr !== '' || newStr !== ''
          ? {
              edit: {
                type: 'string_replace' as const,
                filePath: fp,
                oldString: oldStr,
                newString: newStr,
              },
            }
          : {}),
      }
    }
    case 'MultiEdit': {
      // MultiEdit: { file_path, edits: [{old_string, new_string}, ...] } → 多组 string_replace
      const fp = typeof input?.file_path === 'string' ? input.file_path : ''
      const rawEdits = Array.isArray(input?.edits) ? input!.edits : []
      const edits: Array<{ oldString: string; newString: string }> = []
      for (const e of rawEdits) {
        if (typeof e !== 'object' || e === null) continue
        const o = (e as { old_string?: unknown }).old_string
        const n = (e as { new_string?: unknown }).new_string
        if (typeof o === 'string' && typeof n === 'string') {
          edits.push({ oldString: o, newString: n })
        }
      }
      return {
        kind: 'file_edit',
        title: `MultiEdit: ${fp}`,
        detail: JSON.stringify(input, null, 2),
        ...(edits.length > 0
          ? {
              edit: {
                type: 'string_replace' as const,
                filePath: fp,
                oldString: edits[0]!.oldString,
                newString: edits[0]!.newString,
                edits,
              },
            }
          : {}),
      }
    }
    case 'Write': {
      // Write: { file_path, content } → 整文件覆盖
      const fp = typeof input?.file_path === 'string' ? input.file_path : ''
      const content = typeof input?.content === 'string' ? input.content : ''
      return {
        kind: 'file_edit',
        title: `Write: ${fp}`,
        detail: JSON.stringify(input, null, 2),
        ...(content !== ''
          ? { edit: { type: 'full_content' as const, filePath: fp, content } }
          : {}),
      }
    }
    case 'NotebookEdit': {
      // NotebookEdit: { notebook_path, cell_id, new_source, cell_type, edit_mode }
      // 结构化成 full_content——以 new_source 作为"新内容"展示（绿块=新增/修改的 cell 源码）。
      // 没有 old 概念（取不到原 cell），用 full_content 让 DiffView 全标绿。
      const nbPath = typeof input?.notebook_path === 'string' ? input.notebook_path : ''
      const newSource = typeof input?.new_source === 'string' ? input.new_source : ''
      return {
        kind: 'file_edit',
        title: `NotebookEdit: ${nbPath}`,
        detail: JSON.stringify(input, null, 2),
        ...(newSource !== ''
          ? { edit: { type: 'full_content' as const, filePath: nbPath, content: newSource } }
          : {}),
      }
    }
    case 'NotebookRead':
    case 'Read':
    case 'Glob':
    case 'Grep':
      return {
        kind: 'file_read',
        title:
          typeof input?.file_path === 'string'
            ? `${block.name}: ${input.file_path}`
            : typeof input?.notebook_path === 'string'
              ? `${block.name}: ${input.notebook_path}`
              : block.name,
        detail: JSON.stringify(input, null, 2),
      }
    case 'WebSearch': {
      // WebSearch: { query, allowed_domains?, blocked_domains? }
      const query = typeof input?.query === 'string' ? input.query : ''
      const allowedDomains = Array.isArray(input?.allowed_domains)
        ? input.allowed_domains.filter((d): d is string => typeof d === 'string')
        : undefined
      const blockedDomains = Array.isArray(input?.blocked_domains)
        ? input.blocked_domains.filter((d): d is string => typeof d === 'string')
        : undefined
      return {
        kind: 'web',
        title: query ? `WebSearch: ${query}` : 'WebSearch',
        detail: JSON.stringify(input, null, 2),
        ...(query !== ''
          ? {
              web: {
                type: 'search' as const,
                query,
                ...(allowedDomains && allowedDomains.length > 0 ? { allowedDomains } : {}),
                ...(blockedDomains && blockedDomains.length > 0 ? { blockedDomains } : {}),
              },
            }
          : {}),
      }
    }
    case 'WebFetch': {
      // WebFetch: { url, prompt? }
      const url = typeof input?.url === 'string' ? input.url : ''
      const prompt = typeof input?.prompt === 'string' ? input.prompt : undefined
      return {
        kind: 'web',
        title: url ? `WebFetch: ${url}` : 'WebFetch',
        detail: JSON.stringify(input, null, 2),
        ...(url !== ''
          ? {
              web: {
                type: 'fetch' as const,
                query: url,
                ...(prompt ? { prompt } : {}),
              },
            }
          : {}),
      }
    }
    case 'Task': {
      // Task: { description, prompt } —— 启动子 agent
      const description = typeof input?.description === 'string' ? input.description : ''
      const prompt = typeof input?.prompt === 'string' ? input.prompt : ''
      return {
        kind: 'task',
        title: description ? `Task: ${description}` : 'Task',
        detail: JSON.stringify(input, null, 2),
        ...(description || prompt
          ? { task: { description: description || 'subagent', prompt } }
          : {}),
      }
    }
    case 'EnterPlanMode':
      // 进入计划模式：input 是 {}，没有数据，前端走专门组件显示提示文案
      return {
        kind: 'control',
        title: 'Enter Plan Mode',
        control: { type: 'enter_plan_mode' },
      }
    case 'ExitPlanMode': {
      // 退出计划模式：input.plan 是 markdown 实施方案（用户审批的核心）
      const plan = typeof input?.plan === 'string' ? input.plan : ''
      return {
        kind: 'control',
        title: 'Exit Plan Mode',
        ...(plan ? { detail: plan } : {}),
        control: { type: 'exit_plan_mode', plan },
      }
    }
    case 'TodoWrite': {
      // 更新 todo 列表：input.todos 是 [{content, status, activeForm}]
      const rawTodos = Array.isArray(input?.todos) ? input.todos : []
      const todos = rawTodos
        .filter((t: unknown): t is Record<string, unknown> => typeof t === 'object' && t !== null)
        .map((t) => {
          const statusRaw = t.status
          const status: 'pending' | 'in_progress' | 'completed' =
            statusRaw === 'completed'
              ? 'completed'
              : statusRaw === 'in_progress'
                ? 'in_progress'
                : 'pending'
          const activeForm = typeof t.activeForm === 'string' ? t.activeForm : undefined
          return {
            content: typeof t.content === 'string' ? t.content : '',
            status,
            ...(activeForm !== undefined ? { activeForm } : {}),
          }
        })
      return {
        kind: 'control',
        title: 'TodoWrite',
        control: { type: 'todo_write', todos },
      }
    }
    case 'AskUserQuestion': {
      // 向用户提问：input.questions 是 [{header, question, multiSelect?, options:[{label,description}]}]
      const rawQs = Array.isArray(input?.questions) ? input.questions : []
      const questions = rawQs
        .filter((q: unknown): q is Record<string, unknown> => typeof q === 'object' && q !== null)
        .map((q) => {
          const rawOpts = Array.isArray(q.options) ? q.options : []
          const options = rawOpts
            .filter(
              (o: unknown): o is Record<string, unknown> => typeof o === 'object' && o !== null,
            )
            .map((o) => ({
              label: typeof o.label === 'string' ? o.label : '',
              description: typeof o.description === 'string' ? o.description : '',
            }))
          return {
            header: typeof q.header === 'string' ? q.header : '',
            question: typeof q.question === 'string' ? q.question : '',
            options,
            multiSelect: q.multiSelect === true,
          }
        })
      return {
        kind: 'control',
        title: 'AskUserQuestion',
        control: { type: 'ask_user_question', questions },
      }
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
        const toolUseBlock = block as ToolUseContent
        const tool = toolUseToInfo(toolUseBlock)
        // AskUserQuestion 特殊：携带 questions 字段，让 adapter 推 ask_user_question 事件
        if (
          toolUseBlock.name === 'AskUserQuestion' &&
          tool.control?.type === 'ask_user_question' &&
          tool.control.questions &&
          tool.control.questions.length > 0
        ) {
          yield {
            type: 'tool_call_started',
            turnId,
            itemId,
            tool,
            askUserQuestion: { questions: tool.control.questions },
          }
        } else {
          yield { type: 'tool_call_started', turnId, itemId, tool }
        }
        break
      }
      // tool_result 在 user 消息里，不在这里处理
      default:
        break
    }
  }
}

/**
 * 把 tool_use_result（Task 完成时 user 消息的顶层字段）转成 ToolTaskStats。
 *
 * 非 Task 工具不带这个字段，返回 undefined。
 * 字段全是 optional--claude CLI 版本不同可能缺字段，防御性提取。
 */
export function toolUseResultToStats(tur: unknown): ToolTaskStats | undefined {
  if (tur === null || typeof tur !== 'object') return undefined
  const r = tur as Record<string, unknown>
  const stats = r.toolStats
  return {
    ...(typeof r.agentId === 'string' ? { agentId: r.agentId } : {}),
    ...(typeof r.totalDurationMs === 'number' ? { totalDurationMs: r.totalDurationMs } : {}),
    ...(typeof r.totalTokens === 'number' ? { totalTokens: r.totalTokens } : {}),
    ...(typeof r.totalToolUseCount === 'number' ? { totalToolUseCount: r.totalToolUseCount } : {}),
    ...(typeof r.agentType === 'string' ? { agentType: r.agentType } : {}),
    ...(stats !== null && typeof stats === 'object'
      ? {
          toolStats: {
            ...(typeof (stats as Record<string, unknown>).readCount === 'number'
              ? { readCount: (stats as Record<string, unknown>).readCount as number }
              : {}),
            ...(typeof (stats as Record<string, unknown>).searchCount === 'number'
              ? { searchCount: (stats as Record<string, unknown>).searchCount as number }
              : {}),
            ...(typeof (stats as Record<string, unknown>).bashCount === 'number'
              ? { bashCount: (stats as Record<string, unknown>).bashCount as number }
              : {}),
            ...(typeof (stats as Record<string, unknown>).editFileCount === 'number'
              ? { editFileCount: (stats as Record<string, unknown>).editFileCount as number }
              : {}),
            ...(typeof (stats as Record<string, unknown>).linesAdded === 'number'
              ? { linesAdded: (stats as Record<string, unknown>).linesAdded as number }
              : {}),
            ...(typeof (stats as Record<string, unknown>).linesRemoved === 'number'
              ? { linesRemoved: (stats as Record<string, unknown>).linesRemoved as number }
              : {}),
            ...(typeof (stats as Record<string, unknown>).otherToolCount === 'number'
              ? { otherToolCount: (stats as Record<string, unknown>).otherToolCount as number }
              : {}),
          },
        }
      : {}),
  }
}

/**
 * 从 user 消息（含 tool_result）提取 tool_call_completed 事件。
 *
 * 第二个参数是 user 消息顶层的 tool_use_result 字段（可选）--Task（子 Agent）
 * 完成时 claude CLI 会附加这个字段，携带子 Agent 的耗时 / token / 工具统计。
 * 我们提取成 ToolTaskStats，挂到 tool_call_completed 事件上让 UI 显示。
 */
export function* userToolResultToEvents(
  msg: { message: { content: ContentBlock[] }; tool_use_result?: unknown },
  turnId: string,
): Iterable<TurnEvent> {
  for (const block of msg.message.content) {
    if (block.type === 'tool_result') {
      const result = block as ToolResultContent
      const itemId = result.tool_use_id
      const stats = toolUseResultToStats(msg.tool_use_result)
      yield {
        type: 'tool_call_completed',
        turnId,
        itemId,
        output: toolResultToOutput(result),
        ...(stats !== undefined ? { taskStats: stats } : {}),
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

    // AskUserQuestion 特殊处理：额外携带 questions，让 adapter 推 ask_user_question 事件
    // 给 UI 弹 dialog。其他工具不带 askUserQuestion 字段。
    if (
      block.toolName === 'AskUserQuestion' &&
      info.control?.type === 'ask_user_question' &&
      info.control.questions &&
      info.control.questions.length > 0
    ) {
      return {
        type: 'tool_call_started',
        turnId: this.turnId,
        itemId: block.itemId,
        tool: info,
        askUserQuestion: { questions: info.control.questions },
      }
    }

    return {
      type: 'tool_call_started',
      turnId: this.turnId,
      itemId: block.itemId,
      tool: info,
    }
  }
}

// ============ Claude 权限请求 → ApprovalRequest ============

/**
 * 把 claude permission-prompt-tool 的 input 映射到 catmax 的 ApprovalRequest。
 *
 * claude 调我们的 approve MCP tool 时传：
 *   { tool_name: "Bash" / "Write" / "Edit" / "mcp__xxx__yyy" / ...
 *     input:     工具的原始入参 }
 *
 * 映射规则：
 * - Bash → kind:'shell_command'，detail 显示 `$ <command>`
 * - Write / Edit / MultiEdit / NotebookEdit → kind:'file_edit'，detail 显示 JSON
 * - mcp__* 或其他 → kind:'mcp'，detail 显示 JSON
 * - 风险等级走共享的 assessRisk
 */
export function claudePermissionToApprovalRequest(
  toolName: string,
  input: Record<string, unknown>,
): ApprovalRequest {
  if (toolName === 'Bash') {
    const cmd = typeof input.command === 'string' ? input.command : JSON.stringify(input)
    const description = typeof input.description === 'string' ? input.description : undefined
    const detail = description ? `$ ${cmd}\n\n${description}` : `$ ${cmd}`
    return {
      kind: 'shell_command',
      title: cmd.slice(0, 100),
      detail,
      riskLevel: assessRisk('shell_command', cmd),
    }
  }

  if (
    toolName === 'Write' ||
    toolName === 'Edit' ||
    toolName === 'MultiEdit' ||
    toolName === 'NotebookEdit'
  ) {
    const filePath =
      (typeof input.file_path === 'string' && input.file_path) ||
      (typeof input.notebook_path === 'string' && input.notebook_path) ||
      '<unknown>'
    return {
      kind: 'file_edit',
      title: `${toolName}: ${filePath}`,
      detail: JSON.stringify(input, null, 2),
      riskLevel: assessRisk('file_edit', filePath),
    }
  }

  // mcp__* 或其他未知工具
  return {
    kind: 'mcp',
    title: toolName,
    detail: JSON.stringify(input, null, 2),
    riskLevel: 'medium',
  }
}
