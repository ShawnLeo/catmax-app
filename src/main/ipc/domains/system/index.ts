import type { SystemHandlers } from '@shared/ipc/system'

import { handleRendererRequest } from '../../typed'

import {
  detectProxy,
  getOpenWithApp,
  getPlatformInfo,
  listApplications,
  openDialog,
  openExternal,
  openPath,
  openWithApp,
  openWithApps,
  saveImage,
  setTrayContext,
  setOpenWithApp,
  showItemInFolder,
  takeTrayCommand,
  windowClose,
  windowIsAlwaysOnTop,
  windowIsMaximized,
  windowMaximize,
  windowMinimize,
  windowToggleAlwaysOnTop,
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
  handleRendererRequest<SystemHandlers, 'system.windowToggleAlwaysOnTop'>(
    'system.windowToggleAlwaysOnTop',
    windowToggleAlwaysOnTop,
  )
  handleRendererRequest<SystemHandlers, 'system.windowIsAlwaysOnTop'>(
    'system.windowIsAlwaysOnTop',
    windowIsAlwaysOnTop,
  )
  handleRendererRequest<SystemHandlers, 'system.saveImage'>('system.saveImage', saveImage)
  handleRendererRequest<SystemHandlers, 'system.takeTrayCommand'>(
    'system.takeTrayCommand',
    takeTrayCommand,
  )
  handleRendererRequest<SystemHandlers, 'system.setTrayContext'>(
    'system.setTrayContext',
    setTrayContext,
  )
  handleRendererRequest<SystemHandlers, 'system.openPath'>('system.openPath', openPath)
  handleRendererRequest<SystemHandlers, 'system.showItemInFolder'>(
    'system.showItemInFolder',
    showItemInFolder,
  )
  handleRendererRequest<SystemHandlers, 'system.openWithApps'>('system.openWithApps', openWithApps)
  handleRendererRequest<SystemHandlers, 'system.openWithApp'>('system.openWithApp', openWithApp)
  handleRendererRequest<SystemHandlers, 'system.getOpenWithApp'>(
    'system.getOpenWithApp',
    getOpenWithApp,
  )
  handleRendererRequest<SystemHandlers, 'system.setOpenWithApp'>(
    'system.setOpenWithApp',
    setOpenWithApp,
  )
  handleRendererRequest<SystemHandlers, 'system.listApplications'>(
    'system.listApplications',
    listApplications,
  )
}

export type { SystemHandlers } from '@shared/ipc/system'
