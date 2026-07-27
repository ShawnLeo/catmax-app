import { IPC, PUSH } from '@shared/constants'
import type { BackendHandlers, BackendPushEvents } from '@shared/ipc/backend'
import type { FsHandlers } from '@shared/ipc/fs'
import type { GitHandlers } from '@shared/ipc/git'
import type { PtyHandlers, PtyPushEvents } from '@shared/ipc/pty'
import type { SessionHandlers, SessionPushEvents } from '@shared/ipc/session'
import type { SettingsHandlers } from '@shared/ipc/settings'
import type { SystemHandlers } from '@shared/ipc/system'
import type { WorkspaceHandlers } from '@shared/ipc/workspace'

import { requestMain, subscribeToMainEvent } from '../main/ipc/typed'

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
    touch: requestMain<WorkspaceHandlers, 'workspace.touch'>(IPC.WORKSPACE_TOUCH),
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
    detectProxy: requestMain<SystemHandlers, 'system.detectProxy'>(IPC.SYSTEM_DETECT_PROXY),
    windowMinimize: requestMain<SystemHandlers, 'system.windowMinimize'>(
      IPC.SYSTEM_WINDOW_MINIMIZE,
    ),
    windowMaximize: requestMain<SystemHandlers, 'system.windowMaximize'>(
      IPC.SYSTEM_WINDOW_MAXIMIZE,
    ),
    windowClose: requestMain<SystemHandlers, 'system.windowClose'>(IPC.SYSTEM_WINDOW_CLOSE),
    windowIsMaximized: requestMain<SystemHandlers, 'system.windowIsMaximized'>(
      IPC.SYSTEM_WINDOW_IS_MAXIMIZED,
    ),
    saveImage: requestMain<SystemHandlers, 'system.saveImage'>(IPC.SYSTEM_SAVE_IMAGE),
  },
  backend: {
    list: requestMain<BackendHandlers, 'backend.list'>(IPC.BACKEND_LIST),
    current: requestMain<BackendHandlers, 'backend.current'>(IPC.BACKEND_CURRENT),
    switch: requestMain<BackendHandlers, 'backend.switch'>(IPC.BACKEND_SWITCH),
    listModels: requestMain<BackendHandlers, 'backend.listModels'>(IPC.BACKEND_LIST_MODELS),
    listModelsFor: requestMain<BackendHandlers, 'backend.listModelsFor'>(
      IPC.BACKEND_LIST_MODELS_FOR,
    ),
    refreshModels: requestMain<BackendHandlers, 'backend.refreshModels'>(
      IPC.BACKEND_REFRESH_MODELS,
    ),
    warmup: requestMain<BackendHandlers, 'backend.warmup'>(IPC.BACKEND_WARMUP),
    startTurn: requestMain<BackendHandlers, 'backend.startTurn'>(IPC.BACKEND_START_TURN),
    interruptTurn: requestMain<BackendHandlers, 'backend.interruptTurn'>(
      IPC.BACKEND_INTERRUPT_TURN,
    ),
    respondApproval: requestMain<BackendHandlers, 'backend.respondApproval'>(
      IPC.BACKEND_RESPOND_APPROVAL,
    ),
    respondQuestion: requestMain<BackendHandlers, 'backend.respondQuestion'>(
      IPC.BACKEND_RESPOND_QUESTION,
    ),
    updateTurnConfig: requestMain<BackendHandlers, 'backend.updateTurnConfig'>(
      IPC.BACKEND_UPDATE_TURN_CONFIG,
    ),
    /** 订阅 turnEvent 推送 */
    onTurnEvent: (cb: (payload: BackendPushEvents['backend:turnEvent']) => void) =>
      subscribeToMainEvent<BackendPushEvents, 'backend:turnEvent'>(PUSH.BACKEND_TURN_EVENT, cb),
    onSwitched: (cb: (payload: BackendPushEvents['backend:switched']) => void) =>
      subscribeToMainEvent<BackendPushEvents, 'backend:switched'>(PUSH.BACKEND_SWITCHED, cb),
    onStatusChanged: (cb: (payload: BackendPushEvents['backend:statusChanged']) => void) =>
      subscribeToMainEvent<BackendPushEvents, 'backend:statusChanged'>(
        PUSH.BACKEND_STATUS_CHANGED,
        cb,
      ),
  },
  session: {
    list: requestMain<SessionHandlers, 'session.list'>(IPC.SESSION_LIST),
    create: requestMain<SessionHandlers, 'session.create'>(IPC.SESSION_CREATE),
    remove: requestMain<SessionHandlers, 'session.remove'>(IPC.SESSION_REMOVE),
    reconcile: requestMain<SessionHandlers, 'session.reconcile'>(IPC.SESSION_RECONCILE),
    scanImportable: requestMain<SessionHandlers, 'session.scanImportable'>(
      IPC.SESSION_SCAN_IMPORTABLE,
    ),
    import: requestMain<SessionHandlers, 'session.import'>(IPC.SESSION_IMPORT),
    detail: requestMain<SessionHandlers, 'session.detail'>(IPC.SESSION_DETAIL),
    readSubagentHistory: requestMain<SessionHandlers, 'session.readSubagentHistory'>(
      IPC.SESSION_READ_SUBAGENT_HISTORY,
    ),
    updateConfig: requestMain<SessionHandlers, 'session.updateConfig'>(IPC.SESSION_UPDATE_CONFIG),
    getLastRuntimeConfig: requestMain<SessionHandlers, 'session.getLastRuntimeConfig'>(
      IPC.SESSION_GET_LAST_RUNTIME_CONFIG,
    ),
    setLastRuntimeConfig: requestMain<SessionHandlers, 'session.setLastRuntimeConfig'>(
      IPC.SESSION_SET_LAST_RUNTIME_CONFIG,
    ),
    onTitleChanged: (cb: (payload: SessionPushEvents['session:titleChanged']) => void) =>
      subscribeToMainEvent<SessionPushEvents, 'session:titleChanged'>(
        PUSH.SESSION_TITLE_CHANGED,
        cb,
      ),
  },
  git: {
    status: requestMain<GitHandlers, 'git.status'>(IPC.GIT_STATUS),
  },
  // File Tree Bridge: renderer 的文件访问只能通过这些类型化 IPC 方法进入主进程。
  fs: {
    readDirectory: requestMain<FsHandlers, 'fs.readDirectory'>(IPC.FS_READ_DIRECTORY),
    readFilePreview: requestMain<FsHandlers, 'fs.readFilePreview'>(IPC.FS_READ_FILE_PREVIEW),
    searchFiles: requestMain<FsHandlers, 'fs.searchFiles'>(IPC.FS_SEARCH_FILES),
    resolveFileReference: requestMain<FsHandlers, 'fs.resolveFileReference'>(
      IPC.FS_RESOLVE_FILE_REFERENCE,
    ),
    openInEditor: requestMain<FsHandlers, 'fs.openInEditor'>(IPC.FS_OPEN_IN_EDITOR),
    pathExists: requestMain<FsHandlers, 'fs.pathExists'>(IPC.FS_PATH_EXISTS),
  },
  pty: {
    create: requestMain<PtyHandlers, 'pty.create'>(IPC.PTY_CREATE),
    write: requestMain<PtyHandlers, 'pty.write'>(IPC.PTY_WRITE),
    resize: requestMain<PtyHandlers, 'pty.resize'>(IPC.PTY_RESIZE),
    kill: requestMain<PtyHandlers, 'pty.kill'>(IPC.PTY_KILL),
    onData: (cb: (payload: PtyPushEvents['pty:data']) => void) =>
      subscribeToMainEvent<PtyPushEvents, 'pty:data'>(PUSH.PTY_DATA, cb),
    onExit: (cb: (payload: PtyPushEvents['pty:exit']) => void) =>
      subscribeToMainEvent<PtyPushEvents, 'pty:exit'>(PUSH.PTY_EXIT, cb),
  },
}

export type Api = typeof api
