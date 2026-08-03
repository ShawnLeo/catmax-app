/**
 * 领域模型类型（跨进程共享）。
 * Plan 1 仅含 workspace；session/message 在后续 plan 添加。
 */
import type { BackgroundTaskSnapshot, EffortLevel, PermissionMode } from './backend/types'
import type { BackendId, EditorId } from './constants'

export interface WorkspaceRecord {
  id: string
  /** 主文件夹路径的兼容镜像；新代码优先通过 primaryFolder/folders 取目录。 */
  path: string
  name: string
  folders: WorkspaceFolderRecord[]
  preferredEditor: EditorId | null
  lastOpenedAt: number
  createdAt: number
}

export type WorkspaceFolderRole = 'primary' | 'secondary'

export interface WorkspaceFolderRecord {
  id: string
  workspaceId: string
  path: string
  /** 工作区内唯一、用于文件引用的稳定短名称。 */
  alias: string
  role: WorkspaceFolderRole
  sortOrder: number
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
  /**
   * Session Pin: 置顶时间戳，null = 未置顶。
   * 纯 catmax 本地属性——后端（claude/codex）完全不知情，reconcile 也不会动它。
   */
  pinnedAt: number | null
  /**
   * Session Rename: 标题是否被用户手动改过。
   * true 时后端自动标题（claude aiTitle）不再回写覆盖，见 database.updateSessionTitle。
   */
  titleCustom: boolean
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

/**
 * Turn 是否仍活跃（未进入终态）。
 *
 * 与 main 侧 turn_runs 表的 recoverable 集合（database.ts 的
 * `WHERE status IN ('queued','running','cancelling')`）和协调器终态集合
 * （per-turn-coordinator.ts 的 `Extract<..., 'completed'|'interrupted'|'error'>`）
 * 保持同一划分——renderer reconcile 时据此判断"后端说还在跑吗"。
 */
export function isActiveTurnRun(status: TurnRunStatus): boolean {
  return status === 'running' || status === 'queued' || status === 'cancelling'
}
