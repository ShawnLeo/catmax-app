/**
 * session domain IPC 契约。
 */
import type { EffortLevel, NormalizedMessage, PermissionMode } from '../backend/types'
import type { BackendId } from '../constants'
import type { SessionView } from '../domain'

export interface CreateSessionArgs {
  workspaceId: string
  backend?: BackendId
  cwd: string
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
  initialPrompt?: string
}

/** 「扫描导入」扫到的单条 importable session */
export interface ImportableSession {
  backend: BackendId
  backendThreadId: string
  title: string | null
  lastActiveAt: number
  model: string | null
  /** claude only：反推出的 cwd */
  cwd?: string
  /** claude only：jsonl 文件大小 */
  sizeBytes?: number
  /** 是否已在 db（任意 workspace） */
  alreadyImported: boolean
  /** alreadyImported=true 时所在 workspace id */
  existingWorkspaceId?: string
  /** claude only：反推 cwd 精确匹配到的 workspace id */
  matchedWorkspaceId?: string
}

export interface ScanImportableResult {
  sessions: ImportableSession[]
  /** claude 反推 cwd 无法精确匹配任何 workspace 的条数（不含 alreadyImported） */
  unmatchedCount: number
  /** 单 backend 失败时的错误（如 codex 进程未启动） */
  errors: Array<{ backend: BackendId; error: string }>
}

/** 单条导入项——用户在 dialog 里勾选 + 选好 workspace 后产出 */
export interface ImportSessionItem {
  backend: BackendId
  backendThreadId: string
  workspaceId: string
}

export interface ImportSessionArgs {
  sessions: ImportSessionItem[]
}

export interface ImportSessionsResult {
  imported: SessionView[]
  skipped: Array<{ backendThreadId: string; reason: string }>
}

export type SessionHandlers = {
  'session.list': (args: { workspaceId: string }) => Promise<SessionView[]>
  'session.create': (args: CreateSessionArgs) => Promise<{ sessionId: string }>
  'session.remove': (args: { sessionId: string }) => Promise<void>
  'session.reconcile': (args: { workspaceId: string }) => Promise<{
    added: SessionView[]
    removed: string[]
  }>
  'session.scanImportable': () => Promise<ScanImportableResult>
  'session.import': (args: ImportSessionArgs) => Promise<ImportSessionsResult>
  'session.detail': (args: { sessionId: string }) => Promise<{
    session: SessionView
    messages: NormalizedMessage[]
    /**
     * 后端给的会话标题（claude jsonl 里的 aiTitle）。
     * 为 null 表示后端明确表示无标题；为 undefined 表示后端没给（保持现状）。
     * sessionStore 拿到非 null/非空值时回写到 db + UI。
     */
    aiTitle?: string | null | undefined
  }>
}

/** session 推送事件 payload */
export type SessionPushEvents = {
  /** claude turn 完成后从 jsonl 读到 aiTitle 并回写 db，告知 renderer 刷新侧边栏标题 */
  'session:titleChanged': { sessionId: string; title: string }
}
