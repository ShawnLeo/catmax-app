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
} as const

/** 推送事件名 */
export const PUSH = {
  BACKEND_TURN_EVENT: 'backend:turnEvent',
  BACKEND_SWITCHED: 'backend:switched',
  PTY_DATA: 'pty:data',
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
