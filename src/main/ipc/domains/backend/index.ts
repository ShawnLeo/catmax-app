import type { BackendHandlers } from '@shared/ipc/backend'

import { handleRendererRequest } from '../../typed'

import {
  getCurrentBackend,
  interruptTurn,
  listBackends,
  listModels,
  respondApproval,
  startTurn,
  switchBackend,
} from './handlers'

export function registerBackendHandlers(): void {
  handleRendererRequest<BackendHandlers, 'backend.list'>('backend.list', listBackends)
  handleRendererRequest<BackendHandlers, 'backend.current'>('backend.current', getCurrentBackend)
  handleRendererRequest<BackendHandlers, 'backend.switch'>('backend.switch', switchBackend)
  handleRendererRequest<BackendHandlers, 'backend.listModels'>('backend.listModels', listModels)
  handleRendererRequest<BackendHandlers, 'backend.startTurn'>('backend.startTurn', startTurn)
  handleRendererRequest<BackendHandlers, 'backend.interruptTurn'>(
    'backend.interruptTurn',
    interruptTurn,
  )
  handleRendererRequest<BackendHandlers, 'backend.respondApproval'>(
    'backend.respondApproval',
    respondApproval,
  )
}

export type { BackendHandlers } from '@shared/ipc/backend'
