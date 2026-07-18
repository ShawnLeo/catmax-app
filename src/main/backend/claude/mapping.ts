/**
 * Claude stream-json message → TurnEvent 转译层。
 *
 * Claude 的内容块（content blocks）模型：
 * - text → text_delta（累积）
 * - thinking → reasoning_delta
 * - tool_use → tool_call_started
 * - tool_result（在后续 user 消息里）→ tool_call_completed
 */
import { randomUUID } from 'node:crypto'

import type {
  AssistantMessage,
  ContentBlock,
  ResultMessage,
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
