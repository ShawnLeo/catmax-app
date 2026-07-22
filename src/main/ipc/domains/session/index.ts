import type { SessionHandlers } from '@shared/ipc/session'

import { handleRendererRequest } from '../../typed'

import {
  createSession,
  getSessionDetail,
  getLastRuntimeConfig,
  importSessions,
  listSessions,
  readSubagentHistory,
  reconcileSessions,
  removeSession,
  scanImportableSessions,
  setLastRuntimeConfig,
  updateSessionConfig,
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
  handleRendererRequest<SessionHandlers, 'session.readSubagentHistory'>(
    'session.readSubagentHistory',
    readSubagentHistory,
  )
  handleRendererRequest<SessionHandlers, 'session.updateConfig'>(
    'session.updateConfig',
    updateSessionConfig,
  )
  handleRendererRequest<SessionHandlers, 'session.getLastRuntimeConfig'>(
    'session.getLastRuntimeConfig',
    getLastRuntimeConfig,
  )
  handleRendererRequest<SessionHandlers, 'session.setLastRuntimeConfig'>(
    'session.setLastRuntimeConfig',
    setLastRuntimeConfig,
  )
}

export type { SessionHandlers } from '@shared/ipc/session'
