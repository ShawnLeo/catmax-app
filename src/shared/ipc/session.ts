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
  }>
}
