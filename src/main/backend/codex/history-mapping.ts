/**
 * codex thread/read 返回的 turn/items → NormalizedMessage[]
 *
 * codex 的历史结构：
 *   thread.turns: Turn[]
 *     turn.items: Item[]（userMessage / agentMessage / command_execution / file_change / ...）
 *
 * 转换规则：
 *   - userMessage / user_message → role: 'user', textBlocks
 *   - agentMessage / agent_message → role: 'assistant', textBlocks
 *   - command_execution / file_change / mcp_tool_call → 单独的 role: 'tool' message（之后由
 *     mergeAssistantAndToolMessages 合并到上一个 assistant 的 toolBlocks）
 *   - reasoning → 归到上一个 assistant message 的 textBlocks（kind: 'reasoning'）
 *
 * 协议变化：
 *   - codex 0.93+ 把 item.type 从 snake_case（user_message）改成 camelCase（userMessage）
 *   - catmax 内部 schema 还是 snake_case。这里在解析时做归一化——两种命名都识别，
 *     统一成 snake_case 后再 switch。
 *
 * 注意：codexItemSchema 是 z.union 带 passthrough 兜底分支，switch(item.type) 不会收窄
 * item 字段，访问具体字段时需要 Extract + as cast（与 mapping.ts 一致）。
 */
import { randomUUID } from 'node:crypto'

import type { CodexItem } from '@shared/backend/schema'
import type { NormalizedMessage, ToolOutput } from '@shared/backend/types'

import { codexCommandToOutput, codexFileChangeToOutput, codexItemToToolCallInfo } from './mapping'

// 显式 Extract 各变体（z.union 不收窄 item.type）
type CommandExecutionItem = Extract<CodexItem, { type: 'command_execution' }>
type FileChangeItem = Extract<CodexItem, { type: 'file_change' }>
type UserMessageItem = Extract<CodexItem, { type: 'user_message' }>
type AgentMessageItem = Extract<CodexItem, { type: 'agent_message' }>
type ReasoningItem = Extract<CodexItem, { type: 'reasoning' }>

/**
 * 把 codex 0.93+ 的 camelCase type 名归一化回 snake_case（catmax 内部用）。
 * - userMessage   → user_message
 * - agentMessage  → agent_message
 * - fileChange    → file_change
 * - commandExecution → command_execution
 * - mcpToolCall   → mcp_tool_call
 * - 其他原样返回
 */
function normalizeItemType(type: string): string {
  const camelMap: Record<string, string> = {
    userMessage: 'user_message',
    agentMessage: 'agent_message',
    fileChange: 'file_change',
    commandExecution: 'command_execution',
    mcpToolCall: 'mcp_tool_call',
  }
  return camelMap[type] ?? type
}

/** 从 thread.read 响应提取 turn 数组 */
export function extractTurns(readResult: unknown): unknown[] {
  const thread = (readResult as { thread?: { turns?: unknown[] } }).thread
  return thread?.turns ?? []
}

/** 从 turn 提取 items（用 codexItemSchema 校验每个 item；不合法的跳过） */
export function extractItems(turn: unknown): CodexItem[] {
  const items = (turn as { items?: unknown[] }).items ?? []
  return items.filter((item): item is CodexItem => {
    return typeof item === 'object' && item !== null && 'type' in item && 'id' in item
  })
}

/** 把多个 turn 的 items 展平 + 转成 NormalizedMessage[] */
export function codexTurnsToMessages(turns: unknown[]): NormalizedMessage[] {
  const messages: NormalizedMessage[] = []
  let currentAssistant: NormalizedMessage | null = null

  for (const turn of turns) {
    const turnId = (turn as { id?: string })?.id ?? randomUUID()
    const items = extractItems(turn)

    for (const item of items) {
      const msg = mapItemToMessage(item, turnId)
      if (!msg) continue

      if (msg.role === 'assistant') {
        // 新 assistant message：先 flush 之前的 assistant
        if (currentAssistant) messages.push(currentAssistant)
        currentAssistant = msg
      } else if (msg.role === 'user') {
        // user message：先 flush 之前的 assistant
        if (currentAssistant) {
          messages.push(currentAssistant)
          currentAssistant = null
        }
        messages.push(msg)
      } else if (msg.role === 'tool') {
        // tool message：先 flush 当前的 assistant（不合并到它，后续 mergeAssistantAndToolMessages 处理）
        if (currentAssistant) {
          messages.push(currentAssistant)
          currentAssistant = null
        }
        messages.push(msg)
      }
    }
  }
  // flush 最后一个
  if (currentAssistant) messages.push(currentAssistant)

  return messages
}

/** 单个 codex item → NormalizedMessage（或 null 跳过） */
function mapItemToMessage(item: CodexItem, turnId: string): NormalizedMessage | null {
  const itemId = item.id
  // codex 0.93+ 把 type 改成了 camelCase，这里先归一化成 snake_case 走 switch
  const itemType = normalizeItemType(item.type as string)

  switch (itemType) {
    case 'user_message': {
      const content = (item as unknown as UserMessageItem).content
      const text = extractUserText(content)
      if (!text) return null
      return {
        id: itemId,
        role: 'user',
        turnId,
        textBlocks: [{ id: `${itemId}-text`, text, kind: 'text' }],
        createdAt: 0, // codex 不在 item 里返回 createdAt，UI 用 turns 的时间
      }
    }
    case 'agent_message': {
      const text = (item as unknown as AgentMessageItem).text ?? ''
      return {
        id: itemId,
        role: 'assistant',
        turnId,
        textBlocks: text ? [{ id: `${itemId}-text`, text, kind: 'text' }] : [],
        toolBlocks: [],
        createdAt: 0,
      }
    }
    case 'reasoning': {
      // reasoning 不单独成 message，会被合并到上一个 assistant 的 textBlocks（kind: reasoning）
      // 这里返回一个 assistant message，让 codexTurnsToMessages 当作 assistant 处理
      // —— 若 reasoning 单独出现（前面没有 assistant），就会作为一个 assistant 入列
      const summary = extractReasoningSummary((item as unknown as ReasoningItem).summary)
      return {
        id: itemId,
        role: 'assistant',
        turnId,
        textBlocks: summary
          ? [{ id: `${itemId}-reasoning`, text: summary, kind: 'reasoning' }]
          : [],
        toolBlocks: [],
        createdAt: 0,
      }
    }
    case 'command_execution':
    case 'file_change':
    case 'mcp_tool_call': {
      // 单独成 role: 'tool' message（之后合并到上一个 assistant 的 toolBlocks）
      const toolInfo = codexItemToToolCallInfo(item)
      if (!toolInfo) return null
      let output: ToolOutput | undefined
      if (itemType === 'command_execution') {
        output = codexCommandToOutput(item as unknown as CommandExecutionItem)
      } else if (itemType === 'file_change') {
        output = codexFileChangeToOutput(item as unknown as FileChangeItem)
      }
      return {
        id: itemId,
        role: 'tool',
        turnId,
        textBlocks: [],
        toolBlocks: [
          {
            id: itemId,
            info: toolInfo,
            status: output?.ok === false ? 'failed' : 'completed',
            ...(output !== undefined ? { output } : {}),
          },
        ],
        createdAt: 0,
      }
    }
    default:
      return null
  }
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (typeof block === 'object' && block !== null && 'text' in block) {
        return String((block as { text: unknown }).text)
      }
      return ''
    })
    .join('\n')
    .trim()
}

function extractReasoningSummary(summary: unknown): string {
  if (typeof summary === 'string') return summary
  if (!Array.isArray(summary)) return ''
  return summary
    .map((s) => {
      if (typeof s === 'string') return s
      if (typeof s === 'object' && s !== null && 'text' in s) {
        return String((s as { text: unknown }).text)
      }
      return ''
    })
    .join('\n')
    .trim()
}

/**
 * 合并相邻的 assistant + tool 消息（让 tool_blocks 归属 assistant message）。
 * codex 历史里 assistant message 之后通常跟着 command_execution/file_change，
 * 让它们在 UI 上以 assistant message 的 tool 卡片展示。
 */
export function mergeAssistantAndToolMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
  const result: NormalizedMessage[] = []
  for (const msg of messages) {
    if (msg.role === 'tool' && result.length > 0) {
      const last = result[result.length - 1]!
      if (last.role === 'assistant') {
        // 合并到上一个 assistant
        if (!last.toolBlocks) last.toolBlocks = []
        last.toolBlocks.push(...(msg.toolBlocks ?? []))
        continue
      }
    }
    result.push(msg)
  }
  return result
}
