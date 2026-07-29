import type { BackendHandlers } from '@shared/ipc/backend'

import { handleRendererRequest } from '../../typed'

import {
  cancelBackendInstall,
  getCurrentBackend,
  installBackend,
  interruptTurn,
  listBackendConfigFiles,
  listBackends,
  listModels,
  listModelsFor,
  listTurnRuns,
  readBackendConfigFile,
  refreshModels,
  respondApproval,
  respondQuestion,
  revealBackendConfigFile,
  startTurn,
  steerTurn,
  switchBackend,
  updateTurnConfig,
  validateBackendConfigFile,
  warmupBackend,
  writeBackendConfigFile,
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
  handleRendererRequest<BackendHandlers, 'backend.warmup'>('backend.warmup', warmupBackend)
  handleRendererRequest<BackendHandlers, 'backend.startTurn'>('backend.startTurn', startTurn)
  handleRendererRequest<BackendHandlers, 'backend.interruptTurn'>(
    'backend.interruptTurn',
    interruptTurn,
  )
  handleRendererRequest<BackendHandlers, 'backend.steerTurn'>('backend.steerTurn', steerTurn)
  handleRendererRequest<BackendHandlers, 'backend.listTurnRuns'>(
    'backend.listTurnRuns',
    listTurnRuns,
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
  handleRendererRequest<BackendHandlers, 'backend.install'>('backend.install', installBackend)
  handleRendererRequest<BackendHandlers, 'backend.cancelInstall'>(
    'backend.cancelInstall',
    cancelBackendInstall,
  )
  handleRendererRequest<BackendHandlers, 'backend.listConfigFiles'>(
    'backend.listConfigFiles',
    listBackendConfigFiles,
  )
  handleRendererRequest<BackendHandlers, 'backend.readConfigFile'>(
    'backend.readConfigFile',
    readBackendConfigFile,
  )
  handleRendererRequest<BackendHandlers, 'backend.writeConfigFile'>(
    'backend.writeConfigFile',
    writeBackendConfigFile,
  )
  handleRendererRequest<BackendHandlers, 'backend.validateConfigFile'>(
    'backend.validateConfigFile',
    validateBackendConfigFile,
  )
  handleRendererRequest<BackendHandlers, 'backend.revealConfigFile'>(
    'backend.revealConfigFile',
    revealBackendConfigFile,
  )
}

export type { BackendHandlers } from '@shared/ipc/backend'
