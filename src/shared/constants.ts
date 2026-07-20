/**
 * 跨进程共享常量。
 * 这是单一真源——main 和 renderer 都从这里 import。
 */

/** 后端标识 */
export const BACKEND_IDS = ['codex', 'claude'] as const
export type BackendId = (typeof BACKEND_IDS)[number]

/** 编辑器标识 */
export const EDITOR_IDS = ['vscode', 'cursor', 'intellij', 'webstorm', 'sublime'] as const
export type EditorId = (typeof EDITOR_IDS)[number]

/** IPC channel 名前缀（避免硬编码字符串散落各处） */
export const IPC = {
  // workspace
  WORKSPACE_LIST: 'workspace.list',
  WORKSPACE_ADD: 'workspace.add',
  WORKSPACE_REMOVE: 'workspace.remove',
  WORKSPACE_RENAME: 'workspace.rename',
  WORKSPACE_SET_EDITOR: 'workspace.setEditor',
  // settings
  SETTINGS_GET: 'settings.get',
  SETTINGS_UPDATE: 'settings.update',
  SETTINGS_RESET: 'settings.reset',
  // system
  SYSTEM_PLATFORM_INFO: 'system.platformInfo',
  SYSTEM_OPEN_DIALOG: 'system.openDialog',
  SYSTEM_OPEN_EXTERNAL: 'system.openExternal',
  SYSTEM_DETECT_PROXY: 'system.detectProxy',
  // backend
  BACKEND_LIST: 'backend.list',
  BACKEND_CURRENT: 'backend.current',
  BACKEND_SWITCH: 'backend.switch',
  BACKEND_LIST_MODELS: 'backend.listModels',
  BACKEND_REFRESH_MODELS: 'backend.refreshModels',
  BACKEND_START_TURN: 'backend.startTurn',
  BACKEND_INTERRUPT_TURN: 'backend.interruptTurn',
  BACKEND_RESPOND_APPROVAL: 'backend.respondApproval',
  // session
  SESSION_LIST: 'session.list',
  SESSION_CREATE: 'session.create',
  SESSION_REMOVE: 'session.remove',
  SESSION_RECONCILE: 'session.reconcile',
  SESSION_SCAN_IMPORTABLE: 'session.scanImportable',
  SESSION_IMPORT: 'session.import',
  SESSION_DETAIL: 'session.detail',
  // git
  GIT_STATUS: 'git.status',
  // fs
  FS_READ_DIRECTORY: 'fs.readDirectory',
  FS_READ_FILE_PREVIEW: 'fs.readFilePreview',
  FS_OPEN_IN_EDITOR: 'fs.openInEditor',
  FS_PATH_EXISTS: 'fs.pathExists',
  // pty
  PTY_CREATE: 'pty.create',
  PTY_WRITE: 'pty.write',
  PTY_RESIZE: 'pty.resize',
  PTY_KILL: 'pty.kill',
} as const

/** 推送事件名 */
export const PUSH = {
  BACKEND_TURN_EVENT: 'backend:turnEvent',
  BACKEND_SWITCHED: 'backend:switched',
  BACKEND_STATUS_CHANGED: 'backend:statusChanged',
  /** claude turn 完成后从 jsonl 读到 aiTitle 并回写 db 后，告知 renderer 刷新侧边栏标题 */
  SESSION_TITLE_CHANGED: 'session:titleChanged',
  PTY_DATA: 'pty:data',
  PTY_EXIT: 'pty:exit',
} as const

/** 存储相关 */
export const STORAGE_KEYS = {
  LAST_WORKSPACE_ID: 'last_workspace_id',
  CURRENT_BACKEND: 'current_backend',
} as const

/** 文件预览限制 */
export const MAX_PREVIEW_BYTES = 256 * 1024 // 256KB
export const MAX_TEXT_PREVIEW_BYTES = 256 * 1024

/** 默认设置 */
export const DEFAULT_THEME_MODE = 'system' as const
export const DEFAULT_FONT_SIZE = 14
export const DEFAULT_CHAT_FONT_SIZE = 15
export const DEFAULT_CODE_FONT_SIZE = 13

/** 默认编辑器 */
export const DEFAULT_EDITOR = 'vscode' as const satisfies EditorId
