import type { SystemHandlers } from '@shared/ipc/system'

import { handleRendererRequest } from '../../typed'

import {
  detectProxy,
  getPlatformInfo,
  openDialog,
  openExternal,
  saveImage,
  windowClose,
  windowIsMaximized,
  windowMaximize,
  windowMinimize,
} from './handlers'

export function registerSystemHandlers(): void {
  handleRendererRequest<SystemHandlers, 'system.platformInfo'>(
    'system.platformInfo',
    getPlatformInfo,
  )
  handleRendererRequest<SystemHandlers, 'system.openDialog'>('system.openDialog', openDialog)
  handleRendererRequest<SystemHandlers, 'system.openExternal'>('system.openExternal', openExternal)
  handleRendererRequest<SystemHandlers, 'system.detectProxy'>('system.detectProxy', detectProxy)
  handleRendererRequest<SystemHandlers, 'system.windowMinimize'>(
    'system.windowMinimize',
    windowMinimize,
  )
  handleRendererRequest<SystemHandlers, 'system.windowMaximize'>(
    'system.windowMaximize',
    windowMaximize,
  )
  handleRendererRequest<SystemHandlers, 'system.windowClose'>('system.windowClose', windowClose)
  handleRendererRequest<SystemHandlers, 'system.windowIsMaximized'>(
    'system.windowIsMaximized',
    windowIsMaximized,
  )
  handleRendererRequest<SystemHandlers, 'system.saveImage'>('system.saveImage', saveImage)
}

export type { SystemHandlers } from '@shared/ipc/system'
