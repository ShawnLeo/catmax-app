/**
 * 跨进程共享常量。
 * 这是单一真源——main 和 renderer 都从这里 import。
 */

/** 后端标识 */
export const BACKEND_IDS = ['codex', 'claude'] as const
export type BuiltinBackendId = (typeof BACKEND_IDS)[number]
/** 插件 backend 使用自己的稳定字符串 id，例如 `acme.pi-agent`。 */
export type BackendId = string

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
  WORKSPACE_TOUCH: 'workspace.touch',
  WORKSPACE_UPDATE_FOLDERS: 'workspace.updateFolders',
  // settings
  SETTINGS_GET: 'settings.get',
  SETTINGS_UPDATE: 'settings.update',
  SETTINGS_RESET: 'settings.reset',
  // system
  SYSTEM_PLATFORM_INFO: 'system.platformInfo',
  SYSTEM_OPEN_DIALOG: 'system.openDialog',
  SYSTEM_OPEN_EXTERNAL: 'system.openExternal',
  SYSTEM_DETECT_PROXY: 'system.detectProxy',
  SYSTEM_WINDOW_MINIMIZE: 'system.windowMinimize',
  SYSTEM_WINDOW_MAXIMIZE: 'system.windowMaximize',
  SYSTEM_WINDOW_CLOSE: 'system.windowClose',
  SYSTEM_WINDOW_IS_MAXIMIZED: 'system.windowIsMaximized',
  SYSTEM_WINDOW_TOGGLE_ALWAYS_ON_TOP: 'system.windowToggleAlwaysOnTop',
  SYSTEM_WINDOW_IS_ALWAYS_ON_TOP: 'system.windowIsAlwaysOnTop',
  // 图片预览下载：data:URL / http(s) URL → 弹保存对话框写盘
  SYSTEM_SAVE_IMAGE: 'system.saveImage',
  // backend
  BACKEND_LIST: 'backend.list',
  BACKEND_CURRENT: 'backend.current',
  BACKEND_SWITCH: 'backend.switch',
  BACKEND_LIST_MODELS: 'backend.listModels',
  BACKEND_LIST_MODELS_FOR: 'backend.listModelsFor',
  BACKEND_REFRESH_MODELS: 'backend.refreshModels',
  BACKEND_REFRESH_MODELS_FOR: 'backend.refreshModelsFor',
  BACKEND_WARMUP: 'backend.warmup',
  BACKEND_SLASH_COMMANDS: 'backend.slashCommands',
  BACKEND_START_TURN: 'backend.startTurn',
  BACKEND_INTERRUPT_TURN: 'backend.interruptTurn',
  BACKEND_STEER_TURN: 'backend.steerTurn',
  // Background Tasks Panel: 单条后台任务的停止 + 输出尾部读取
  BACKEND_STOP_BACKGROUND_TASK: 'backend.stopBackgroundTask',
  BACKEND_READ_BACKGROUND_TASK_OUTPUT: 'backend.readBackgroundTaskOutput',
  BACKEND_LIST_TURN_RUNS: 'backend.listTurnRuns',
  BACKEND_RESPOND_APPROVAL: 'backend.respondApproval',
  BACKEND_RESPOND_QUESTION: 'backend.respondQuestion',
  BACKEND_UPDATE_TURN_CONFIG: 'backend.updateTurnConfig',
  // Backend Install: 下载官方产物到 userData 并写回 backendPaths
  BACKEND_INSTALL: 'backend.install',
  BACKEND_CANCEL_INSTALL: 'backend.cancelInstall',
  // Backend Config Files: 直接编辑后端自己的本地配置文件（~/.codex/config.toml 等）
  BACKEND_LIST_CONFIG_FILES: 'backend.listConfigFiles',
  BACKEND_READ_CONFIG_FILE: 'backend.readConfigFile',
  BACKEND_WRITE_CONFIG_FILE: 'backend.writeConfigFile',
  BACKEND_VALIDATE_CONFIG_FILE: 'backend.validateConfigFile',
  BACKEND_REVEAL_CONFIG_FILE: 'backend.revealConfigFile',
  // Protocol Bridge: 本机协议转换桥（Responses ↔ Anthropic 等）
  BACKEND_BRIDGE_STATUS: 'backend.bridgeStatus',
  BACKEND_SET_BRIDGE_CREDENTIAL: 'backend.setBridgeCredential',
  BACKEND_TEST_BRIDGE_UPSTREAM: 'backend.testBridgeUpstream',
  BACKEND_BRIDGE_CREDENTIAL_READY: 'backend.bridgeCredentialReady',
  // session
  SESSION_LIST: 'session.list',
  SESSION_CREATE: 'session.create',
  SESSION_REMOVE: 'session.remove',
  SESSION_SET_PINNED: 'session.setPinned',
  SESSION_RENAME: 'session.rename',
  SESSION_REVEAL_IN_FOLDER: 'session.revealInFolder',
  SESSION_FORK: 'session.fork',
  SESSION_RECONCILE: 'session.reconcile',
  SESSION_SCAN_IMPORTABLE: 'session.scanImportable',
  SESSION_IMPORT: 'session.import',
  SESSION_DETAIL: 'session.detail',
  SESSION_READ_SUBAGENT_HISTORY: 'session.readSubagentHistory',
  SESSION_UPDATE_CONFIG: 'session.updateConfig',
  SESSION_GET_LAST_RUNTIME_CONFIG: 'session.getLastRuntimeConfig',
  SESSION_SET_LAST_RUNTIME_CONFIG: 'session.setLastRuntimeConfig',
  // git
  GIT_STATUS: 'git.status',
  // File Tree IPC Channels: 目录、搜索、引用解析、预览和外部编辑器入口。
  FS_READ_DIRECTORY: 'fs.readDirectory',
  FS_READ_FILE_PREVIEW: 'fs.readFilePreview',
  FS_SEARCH_FILES: 'fs.searchFiles',
  FS_RESOLVE_FILE_REFERENCE: 'fs.resolveFileReference',
  FS_OPEN_IN_EDITOR: 'fs.openInEditor',
  FS_PATH_EXISTS: 'fs.pathExists',
  FS_READ_MENTION_PREVIEW: 'fs.readMentionPreview',
  // pty
  PTY_CREATE: 'pty.create',
  PTY_WRITE: 'pty.write',
  PTY_RESIZE: 'pty.resize',
  PTY_KILL: 'pty.kill',
  // skills（Unified Skill Center）
  SKILLS_LIST: 'skills.list',
  SKILLS_SET_ENABLED: 'skills.setEnabled',
  SKILLS_MIRROR: 'skills.mirror',
  SKILLS_MIGRATE: 'skills.migrate',
  SKILLS_REMOVE: 'skills.remove',
  SKILLS_REVEAL: 'skills.reveal',
  SKILLS_OPEN_IN_EDITOR: 'skills.openInEditor',
} as const

/** 推送事件名 */
export const PUSH = {
  BACKEND_TURN_EVENT: 'backend:turnEvent',
  BACKEND_SWITCHED: 'backend:switched',
  BACKEND_STATUS_CHANGED: 'backend:statusChanged',
  /** Backend Install: 下载/解压进度，设置页的安装卡片消费 */
  BACKEND_INSTALL_PROGRESS: 'backend:installProgress',
  /** claude turn 完成后从 jsonl 读到 aiTitle 并回写 db 后，告知 renderer 刷新侧边栏标题 */
  SESSION_TITLE_CHANGED: 'session:titleChanged',
  PTY_DATA: 'pty:data',
  PTY_EXIT: 'pty:exit',
  /** Unified Skill Center: 后端报告技能集合变了，renderer 重扫 */
  SKILLS_CHANGED: 'skills:changed',
} as const

/** 存储相关 */
export const STORAGE_KEYS = {
  LAST_WORKSPACE_ID: 'last_workspace_id',
  CURRENT_BACKEND: 'current_backend',
  /**
   * 最近一次"运行时配置"快照（后端 / 模型 / 权限模式 / 思考强度），
   * 作为新建会话的默认配置。值是 RuntimeConfigSnapshot 的 JSON 字符串。
   */
  LAST_RUNTIME_CONFIG: 'last_runtime_config',
} as const

/** 文件预览限制 */
export const MAX_PREVIEW_BYTES = 256 * 1024 // 256KB
export const MAX_TEXT_PREVIEW_BYTES = 256 * 1024

/** 默认设置 */
export const DEFAULT_THEME_MODE = 'system' as const
/*
 * 三条字号基准的默认值。themes.css 里 --ui-font-size / --chat-font-size /
 * --code-font-size 的兜底值必须与这里一致——那是设置加载完成前的一瞬间用的。
 */
/** 界面：侧边栏 / 面板 / 设置页 / 命令面板 */
export const DEFAULT_FONT_SIZE = 14
/** 对话正文与 Markdown（含标题） */
export const DEFAULT_CHAT_FONT_SIZE = 13
/** 等宽区域：代码块 / diff / 终端 / 文件预览 */
export const DEFAULT_CODE_FONT_SIZE = 13

/** 默认编辑器 */
export const DEFAULT_EDITOR = 'vscode' as const satisfies EditorId

/**
 * Narrow Window: 窗口能缩到的最小尺寸（main 的 BrowserWindow 约束）。
 *
 * 宽度按手机竖屏视口取——360 是最窄的常见 Android 视口，iPhone 是 375 起，
 * 取 360 才能把两类都覆盖到。高度不是手机形态的瓶颈（最矮的 iPhone SE 竖屏也有
 * 667），保持原值即可。
 *
 * 注意：缩到这么窄时，渲染层那些面板的"理想最小宽度"（侧栏 280 / 右栏 320 / 聊天区
 * 250）加起来会超出窗口。届时侧栏已折叠、右栏走浮层形态（见 useRightPanelOverlay），
 * 聊天区是唯一常驻的列，不会顶出窗口。
 */
export const MIN_WINDOW_WIDTH = 360
export const MIN_WINDOW_HEIGHT = 600
/** 手机形态断点：标题栏置顶按钮与面板自动收起共用这个宽度语义。 */
export const NARROW_WINDOW_BREAKPOINT = 640
