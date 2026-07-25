import type { ContextBlock as ContextTagBlock } from '../context-tag-types'
import type { ToolCallInfo, ToolOutput, ToolTaskStats } from '../types'

export interface BaseContentBlock {
  id: string
  type: string
  createdAt?: number
}

export interface TextContentBlock extends BaseContentBlock {
  type: 'text'
  text: string
  /**
   * Codex app-server classifies assistant text so the renderer can keep interim
   * commentary inside the collapsible work log while leaving the final answer visible.
   */
  phase?: 'commentary' | 'final_answer'
}

export interface ReasoningContentBlock extends BaseContentBlock {
  type: 'reasoning'
  text: string
  startedAt?: number
  endedAt?: number
  /** 历史回放可直接使用 app-server 的 turn.durationMs。 */
  durationMs?: number
  /** 后端可覆盖完成态标题，例如 Codex 使用“已处理”。 */
  completedLabel?: string
  defaultCollapsed?: boolean
}

export interface ToolCallContentBlock extends BaseContentBlock {
  type: 'tool_call'
  info: ToolCallInfo
  status: 'running' | 'completed' | 'failed'
  output?: ToolOutput
  approvalState?: 'pending' | 'approved' | 'rejected'
  approvalRequestId?: string
  startedAt?: number
  taskStats?: ToolTaskStats
}

export interface ContextContentBlock extends BaseContentBlock, ContextTagBlock {
  type: 'context'
}

export interface CompactDividerContentBlock extends BaseContentBlock {
  type: 'compact_divider'
  summary?: string
}

export function textBlock(id: string, text: string): TextContentBlock {
  return { id, type: 'text', text }
}

export function contextBlocks(items: ContextTagBlock[], idPrefix: string): ContextContentBlock[] {
  return items.map((item, index) => ({
    id: `${idPrefix}-context-${index}`,
    type: 'context',
    ...item,
  }))
}
