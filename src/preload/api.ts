import { IPC } from '@shared/constants'
import type { SettingsHandlers } from '@shared/ipc/settings'
import type { SystemHandlers } from '@shared/ipc/system'
import type { WorkspaceHandlers } from '@shared/ipc/workspace'

import { requestMain } from '../main/ipc/typed'

/**
 * 暴露给渲染层的 api 对象。
 * 通过 contextBridge 注入 window.api。
 * 类型从 shared/ipc/* 的 handler 签名派生。
 */
export const api = {
  workspace: {
    list: requestMain<WorkspaceHandlers, 'workspace.list'>(IPC.WORKSPACE_LIST),
    add: requestMain<WorkspaceHandlers, 'workspace.add'>(IPC.WORKSPACE_ADD),
    remove: requestMain<WorkspaceHandlers, 'workspace.remove'>(IPC.WORKSPACE_REMOVE),
    rename: requestMain<WorkspaceHandlers, 'workspace.rename'>(IPC.WORKSPACE_RENAME),
    setEditor: requestMain<WorkspaceHandlers, 'workspace.setEditor'>(IPC.WORKSPACE_SET_EDITOR),
  },
  settings: {
    get: requestMain<SettingsHandlers, 'settings.get'>(IPC.SETTINGS_GET),
    update: requestMain<SettingsHandlers, 'settings.update'>(IPC.SETTINGS_UPDATE),
    reset: requestMain<SettingsHandlers, 'settings.reset'>(IPC.SETTINGS_RESET),
  },
  system: {
    platformInfo: requestMain<SystemHandlers, 'system.platformInfo'>(IPC.SYSTEM_PLATFORM_INFO),
    openDialog: requestMain<SystemHandlers, 'system.openDialog'>(IPC.SYSTEM_OPEN_DIALOG),
    openExternal: requestMain<SystemHandlers, 'system.openExternal'>(IPC.SYSTEM_OPEN_EXTERNAL),
  },
}

export type Api = typeof api
