/**
 * 领域模型类型（跨进程共享）。
 * Plan 1 仅含 workspace；session/message 在后续 plan 添加。
 */
import type { EditorId } from './constants'

export interface WorkspaceRecord {
  id: string
  path: string
  name: string
  preferredEditor: EditorId | null
  lastOpenedAt: number
  createdAt: number
}
