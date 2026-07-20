import type { SessionHandlers } from '@shared/ipc/session'

import { handleRendererRequest } from '../../typed'

import {
  createSession,
  getSessionDetail,
  importSessions,
  listSessions,
  reconcileSessions,
  removeSession,
  scanImportableSessions,
} from './handlers'

export function registerSessionHandlers(): void {
  handleRendererRequest<SessionHandlers, 'session.list'>('session.list', listSessions)
  handleRendererRequest<SessionHandlers, 'session.create'>('session.create', createSession)
  handleRendererRequest<SessionHandlers, 'session.remove'>('session.remove', removeSession)
  handleRendererRequest<SessionHandlers, 'session.reconcile'>(
    'session.reconcile',
    reconcileSessions,
  )
  handleRendererRequest<SessionHandlers, 'session.scanImportable'>(
    'session.scanImportable',
    scanImportableSessions,
  )
  handleRendererRequest<SessionHandlers, 'session.import'>('session.import', importSessions)
  handleRendererRequest<SessionHandlers, 'session.detail'>('session.detail', getSessionDetail)
}

export type { SessionHandlers } from '@shared/ipc/session'
