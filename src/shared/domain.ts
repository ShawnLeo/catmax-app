/**
 * 领域模型类型（跨进程共享）。
 * Plan 1 仅含 workspace；session/message 在后续 plan 添加。
 */
import type { EffortLevel, PermissionMode } from './backend/types'
import type { BackendId, EditorId } from './constants'

export interface WorkspaceRecord {
  id: string
  path: string
  name: string
  preferredEditor: EditorId | null
  lastOpenedAt: number
  createdAt: number
}

export interface SessionRecord {
  id: string
  backend: BackendId
  backendThreadId: string
  workspaceId: string
  title: string | null
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode | null
  turnCount: number
  createdAt: number
  lastActiveAt: number
}

/** 渲染层用的 Session 视图（含 continuable / stale 标记） */
export interface SessionView extends SessionRecord {
  /** 是否可用当前后端继续聊（= session.backend === currentBackend） */
  continuable: boolean
  /** 后端已删除但 App 还有索引 */
  stale: boolean
}

export interface MessagePreview {
  id: string
  sessionId: string
  turnId: string
  role: 'user' | 'assistant'
  textPreview: string
  toolCallCount: number
  createdAt: number
}
