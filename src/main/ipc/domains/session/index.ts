import type { SessionHandlers } from '@shared/ipc/session'

import { handleRendererRequest } from '../../typed'

import {
  createSession,
  getSessionDetail,
  listSessions,
  reconcileSessions,
  removeSession,
} from './handlers'

export function registerSessionHandlers(): void {
  handleRendererRequest<SessionHandlers, 'session.list'>('session.list', listSessions)
  handleRendererRequest<SessionHandlers, 'session.create'>('session.create', createSession)
  handleRendererRequest<SessionHandlers, 'session.remove'>('session.remove', removeSession)
  handleRendererRequest<SessionHandlers, 'session.reconcile'>(
    'session.reconcile',
    reconcileSessions,
  )
  handleRendererRequest<SessionHandlers, 'session.detail'>('session.detail', getSessionDetail)
}

export type { SessionHandlers } from '@shared/ipc/session'
