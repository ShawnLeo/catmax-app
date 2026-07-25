import type { BackendHandlers } from '@shared/ipc/backend'

import { handleRendererRequest } from '../../typed'

import {
  getCurrentBackend,
  interruptTurn,
  listBackends,
  listModels,
  listModelsFor,
  refreshModels,
  respondApproval,
  respondQuestion,
  startTurn,
  switchBackend,
  updateTurnConfig,
} from './handlers'

export function registerBackendHandlers(): void {
  handleRendererRequest<BackendHandlers, 'backend.list'>('backend.list', listBackends)
  handleRendererRequest<BackendHandlers, 'backend.current'>('backend.current', getCurrentBackend)
  handleRendererRequest<BackendHandlers, 'backend.switch'>('backend.switch', switchBackend)
  handleRendererRequest<BackendHandlers, 'backend.listModels'>('backend.listModels', listModels)
  handleRendererRequest<BackendHandlers, 'backend.listModelsFor'>(
    'backend.listModelsFor',
    listModelsFor,
  )
  handleRendererRequest<BackendHandlers, 'backend.refreshModels'>(
    'backend.refreshModels',
    refreshModels,
  )
  handleRendererRequest<BackendHandlers, 'backend.startTurn'>('backend.startTurn', startTurn)
  handleRendererRequest<BackendHandlers, 'backend.interruptTurn'>(
    'backend.interruptTurn',
    interruptTurn,
  )
  handleRendererRequest<BackendHandlers, 'backend.respondApproval'>(
    'backend.respondApproval',
    respondApproval,
  )
  handleRendererRequest<BackendHandlers, 'backend.respondQuestion'>(
    'backend.respondQuestion',
    respondQuestion,
  )
  handleRendererRequest<BackendHandlers, 'backend.updateTurnConfig'>(
    'backend.updateTurnConfig',
    updateTurnConfig,
  )
}

export type { BackendHandlers } from '@shared/ipc/backend'
