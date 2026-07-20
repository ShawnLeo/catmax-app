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

export type SessionHandlers = {
  'session.list': (args: { workspaceId: string }) => Promise<SessionView[]>
  'session.create': (args: CreateSessionArgs) => Promise<{ sessionId: string }>
  'session.remove': (args: { sessionId: string }) => Promise<void>
  'session.reconcile': (args: { workspaceId: string }) => Promise<{
    added: SessionView[]
    removed: string[]
  }>
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
