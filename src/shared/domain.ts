/**
 * 领域模型类型（跨进程共享）。
 * Plan 1 仅含 workspace；session/message 在后续 plan 添加。
 */
import type { BackgroundTaskSnapshot, EffortLevel, PermissionMode } from './backend/types'
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

export type TurnRunStatus =
  'queued' | 'running' | 'cancelling' | 'completed' | 'interrupted' | 'error'

/**
 * 主进程 per-turn 协调器的持久化快照。
 *
 * backendTurnId 是 adapter 实际产生的 turn id；id 是协调器在请求进入时生成的稳定 id。
 * 应用重启后本地 SDK 子进程无法重连，queued/running/cancelling 会恢复为 interrupted。
 */
export interface TurnRunRecord {
  id: string
  sessionId: string
  backend: BackendId
  backendTurnId: string | null
  status: TurnRunStatus
  backgroundTasks: BackgroundTaskSnapshot[]
  createdAt: number
  startedAt: number | null
  lastEventAt: number | null
  completedAt: number | null
  error: string | null
}
