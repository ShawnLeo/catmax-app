import { IPC, PUSH } from '@shared/constants'
import type { BackendHandlers, BackendPushEvents } from '@shared/ipc/backend'
import type { FsHandlers } from '@shared/ipc/fs'
import type { GitHandlers } from '@shared/ipc/git'
import type { McpHandlers } from '@shared/ipc/mcp'
import type { PtyHandlers, PtyPushEvents } from '@shared/ipc/pty'
import type { SessionHandlers, SessionPushEvents } from '@shared/ipc/session'
import type { SettingsHandlers } from '@shared/ipc/settings'
import type { SkillsHandlers, SkillsPushEvents } from '@shared/ipc/skills'
import type { SystemHandlers, SystemPushEvents } from '@shared/ipc/system'
import type { WorkspaceHandlers } from '@shared/ipc/workspace'
import * as electron from 'electron'

import { requestMain, subscribeToMainEvent } from '../main/ipc/typed'

/**
 * File Mention: 从 OS 拖进来的 File 对象取真实磁盘路径。
 *
 * 这是 api 里唯一不走 IPC 的成员——路径就在渲染进程手里，只是拿它需要一个
 * 渲染层没有的 electron 模块，所以桥在 preload 而不是 main。
 *
 * Electron 版本兼容：`File.path` 这个非标准扩展在 32 里被移除，换成了
 * `webUtils.getPathForFile()`；而 31（当前版本）还没有 `webUtils`。两条路都留着，
 * 升级时这里自动切过去，调用方不用动。`webUtils` 不写成静态 import——31 的类型
 * 定义里没有这个导出，直接 import 通不过 typecheck。
 */
const webUtils = (electron as { webUtils?: { getPathForFile(file: File): string } }).webUtils

function getPathForFile(file: File): string {
  if (webUtils) return webUtils.getPathForFile(file)
  return (file as File & { path?: string }).path ?? ''
}

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
    updateFolders: requestMain<WorkspaceHandlers, 'workspace.updateFolders'>(
      IPC.WORKSPACE_UPDATE_FOLDERS,
    ),
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
    windowToggleAlwaysOnTop: requestMain<SystemHandlers, 'system.windowToggleAlwaysOnTop'>(
      IPC.SYSTEM_WINDOW_TOGGLE_ALWAYS_ON_TOP,
    ),
    windowIsAlwaysOnTop: requestMain<SystemHandlers, 'system.windowIsAlwaysOnTop'>(
      IPC.SYSTEM_WINDOW_IS_ALWAYS_ON_TOP,
    ),
    saveImage: requestMain<SystemHandlers, 'system.saveImage'>(IPC.SYSTEM_SAVE_IMAGE),
    /** Tray: 取走主进程暂存的托盘命令（窗口是被托盘拉起来的场景），take-once。 */
    takeTrayCommand: requestMain<SystemHandlers, 'system.takeTrayCommand'>(
      IPC.SYSTEM_TAKE_TRAY_COMMAND,
    ),
    /** Tray: 窗口本来就活着时，托盘菜单的命令走这条 push。 */
    onTrayCommand: (cb: (payload: SystemPushEvents['system:trayCommand']) => void) =>
      subscribeToMainEvent<SystemPushEvents, 'system:trayCommand'>(PUSH.TRAY_COMMAND, cb),
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
    refreshModelsFor: requestMain<BackendHandlers, 'backend.refreshModelsFor'>(
      IPC.BACKEND_REFRESH_MODELS_FOR,
    ),
    warmup: requestMain<BackendHandlers, 'backend.warmup'>(IPC.BACKEND_WARMUP),
    slashCommands: requestMain<BackendHandlers, 'backend.slashCommands'>(
      IPC.BACKEND_SLASH_COMMANDS,
    ),
    startTurn: requestMain<BackendHandlers, 'backend.startTurn'>(IPC.BACKEND_START_TURN),
    interruptTurn: requestMain<BackendHandlers, 'backend.interruptTurn'>(
      IPC.BACKEND_INTERRUPT_TURN,
    ),
    steerTurn: requestMain<BackendHandlers, 'backend.steerTurn'>(IPC.BACKEND_STEER_TURN),
    stopBackgroundTask: requestMain<BackendHandlers, 'backend.stopBackgroundTask'>(
      IPC.BACKEND_STOP_BACKGROUND_TASK,
    ),
    readBackgroundTaskOutput: requestMain<BackendHandlers, 'backend.readBackgroundTaskOutput'>(
      IPC.BACKEND_READ_BACKGROUND_TASK_OUTPUT,
    ),
    listTurnRuns: requestMain<BackendHandlers, 'backend.listTurnRuns'>(IPC.BACKEND_LIST_TURN_RUNS),
    respondApproval: requestMain<BackendHandlers, 'backend.respondApproval'>(
      IPC.BACKEND_RESPOND_APPROVAL,
    ),
    respondQuestion: requestMain<BackendHandlers, 'backend.respondQuestion'>(
      IPC.BACKEND_RESPOND_QUESTION,
    ),
    updateTurnConfig: requestMain<BackendHandlers, 'backend.updateTurnConfig'>(
      IPC.BACKEND_UPDATE_TURN_CONFIG,
    ),
    install: requestMain<BackendHandlers, 'backend.install'>(IPC.BACKEND_INSTALL),
    cancelInstall: requestMain<BackendHandlers, 'backend.cancelInstall'>(
      IPC.BACKEND_CANCEL_INSTALL,
    ),
    // Backend Config Files: 直接编辑 ~/.codex/config.toml 等后端自己的配置文件
    listConfigFiles: requestMain<BackendHandlers, 'backend.listConfigFiles'>(
      IPC.BACKEND_LIST_CONFIG_FILES,
    ),
    readConfigFile: requestMain<BackendHandlers, 'backend.readConfigFile'>(
      IPC.BACKEND_READ_CONFIG_FILE,
    ),
    writeConfigFile: requestMain<BackendHandlers, 'backend.writeConfigFile'>(
      IPC.BACKEND_WRITE_CONFIG_FILE,
    ),
    validateConfigFile: requestMain<BackendHandlers, 'backend.validateConfigFile'>(
      IPC.BACKEND_VALIDATE_CONFIG_FILE,
    ),
    revealConfigFile: requestMain<BackendHandlers, 'backend.revealConfigFile'>(
      IPC.BACKEND_REVEAL_CONFIG_FILE,
    ),
    // Protocol Bridge: 本机协议转换桥
    bridgeStatus: requestMain<BackendHandlers, 'backend.bridgeStatus'>(IPC.BACKEND_BRIDGE_STATUS),
    setBridgeCredential: requestMain<BackendHandlers, 'backend.setBridgeCredential'>(
      IPC.BACKEND_SET_BRIDGE_CREDENTIAL,
    ),
    testBridgeUpstream: requestMain<BackendHandlers, 'backend.testBridgeUpstream'>(
      IPC.BACKEND_TEST_BRIDGE_UPSTREAM,
    ),
    bridgeCredentialReady: requestMain<BackendHandlers, 'backend.bridgeCredentialReady'>(
      IPC.BACKEND_BRIDGE_CREDENTIAL_READY,
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
    /** Backend Install: 订阅安装进度（下载字节数 / 阶段 / 终态） */
    onInstallProgress: (cb: (payload: BackendPushEvents['backend:installProgress']) => void) =>
      subscribeToMainEvent<BackendPushEvents, 'backend:installProgress'>(
        PUSH.BACKEND_INSTALL_PROGRESS,
        cb,
      ),
  },
  session: {
    list: requestMain<SessionHandlers, 'session.list'>(IPC.SESSION_LIST),
    create: requestMain<SessionHandlers, 'session.create'>(IPC.SESSION_CREATE),
    remove: requestMain<SessionHandlers, 'session.remove'>(IPC.SESSION_REMOVE),
    setPinned: requestMain<SessionHandlers, 'session.setPinned'>(IPC.SESSION_SET_PINNED),
    rename: requestMain<SessionHandlers, 'session.rename'>(IPC.SESSION_RENAME),
    revealInFolder: requestMain<SessionHandlers, 'session.revealInFolder'>(
      IPC.SESSION_REVEAL_IN_FOLDER,
    ),
    fork: requestMain<SessionHandlers, 'session.fork'>(IPC.SESSION_FORK),
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
    readMentionPreview: requestMain<FsHandlers, 'fs.readMentionPreview'>(
      IPC.FS_READ_MENTION_PREVIEW,
    ),
    getPathForFile,
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
  skills: {
    list: requestMain<SkillsHandlers, 'skills.list'>(IPC.SKILLS_LIST),
    setEnabled: requestMain<SkillsHandlers, 'skills.setEnabled'>(IPC.SKILLS_SET_ENABLED),
    mirror: requestMain<SkillsHandlers, 'skills.mirror'>(IPC.SKILLS_MIRROR),
    migrate: requestMain<SkillsHandlers, 'skills.migrate'>(IPC.SKILLS_MIGRATE),
    remove: requestMain<SkillsHandlers, 'skills.remove'>(IPC.SKILLS_REMOVE),
    reveal: requestMain<SkillsHandlers, 'skills.reveal'>(IPC.SKILLS_REVEAL),
    openInEditor: requestMain<SkillsHandlers, 'skills.openInEditor'>(IPC.SKILLS_OPEN_IN_EDITOR),
    /** 后端报告技能集合变了（空 payload，收到就重扫）。 */
    onChanged: (cb: (payload: SkillsPushEvents['skills:changed']) => void) =>
      subscribeToMainEvent<SkillsPushEvents, 'skills:changed'>(PUSH.SKILLS_CHANGED, cb),
  },
  mcp: {
    list: requestMain<McpHandlers, 'mcp.list'>(IPC.MCP_LIST),
    reveal: requestMain<McpHandlers, 'mcp.reveal'>(IPC.MCP_REVEAL),
    refreshRuntime: requestMain<McpHandlers, 'mcp.refreshRuntime'>(IPC.MCP_REFRESH_RUNTIME),
    setEnabled: requestMain<McpHandlers, 'mcp.setEnabled'>(IPC.MCP_SET_ENABLED),
    trustProject: requestMain<McpHandlers, 'mcp.trustProject'>(IPC.MCP_TRUST_PROJECT),
    sync: requestMain<McpHandlers, 'mcp.sync'>(IPC.MCP_SYNC),
    unsync: requestMain<McpHandlers, 'mcp.unsync'>(IPC.MCP_UNSYNC),
    remove: requestMain<McpHandlers, 'mcp.remove'>(IPC.MCP_REMOVE),
  },
}

export type Api = typeof api
