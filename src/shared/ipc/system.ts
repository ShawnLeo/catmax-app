export interface PlatformInfo {
  platform: 'darwin' | 'win32' | 'linux'
  arch: 'arm64' | 'x64'
  osVersion: string
  appVersion: string
  electronVersion: string
}

export interface OpenDialogArgs {
  title?: string
  defaultPath?: string
  properties?: Array<'openDirectory' | 'openFile' | 'multiSelections'>
}

export interface OpenDialogResult {
  canceled: boolean
  filePaths: string[]
}

/** macOS / Windows / Linux 系统代理检测结果 */
export interface DetectedSystemProxy {
  /** 是否检测到启用的系统代理 */
  enabled: boolean
  /** 代理 URL，如 http://127.0.0.1:7890 */
  url: string
  /** bypass 列表（逗号分隔），可能为 null */
  bypass: string | null
  /** 检测来源（macOS = scutil，Windows = registry，Linux = env） */
  source: 'macos-scutil' | 'windows-registry' | 'linux-env' | 'none'
}

/**
 * Tray: 托盘菜单能触发的渲染层命令。
 *
 * 取值刻意就是 commandRegistry 的命令 id——主进程只负责报"用户点了哪一项"，
 * 具体行为仍然只在 renderer/lib/commands.ts 里定义一份，不在主进程复制一遍路由逻辑。
 */
export type TrayCommandId = 'session.new' | 'app.go-settings'

/**
 * Tray: 渲染层上报的托盘菜单门控条件。
 *
 * 为什么只有 canCreateSession 一项、而没有 loggedIn——登录态的真相源在主进程
 * （auth-store 落盘的 auth.json），主进程自己读就是权威值，而且窗口关掉后它依然准；
 * 反过来「当前是不是停在能建会话的页面」只有渲染层知道路由和工作区，主进程无从判断，
 * 也不该把路由规则在主进程复制一份（与 TrayCommandId 的分工一致）。
 */
export interface TrayContext {
  /** 当前页面允许新建会话：已登录 + 停在 /chat + 有选中的工作区。 */
  canCreateSession: boolean
}

export type SystemPushEvents = {
  'system:trayCommand': { command: TrayCommandId }
}

export type SystemHandlers = {
  'system.platformInfo': () => Promise<PlatformInfo>
  'system.openDialog': (args: OpenDialogArgs) => Promise<OpenDialogResult>
  'system.openExternal': (args: { url: string }) => Promise<void>
  /** 检测当前系统的代理设置（macOS 读 scutil，Windows 读注册表，Linux 读 env） */
  'system.detectProxy': () => Promise<DetectedSystemProxy>
  /** 窗口控制 */
  'system.windowMinimize': () => Promise<void>
  'system.windowMaximize': () => Promise<void>
  'system.windowClose': () => Promise<void>
  'system.windowIsMaximized': () => Promise<boolean>
  /** 切换窗口置顶状态，返回切换后的状态 */
  'system.windowToggleAlwaysOnTop': () => Promise<boolean>
  'system.windowIsAlwaysOnTop': () => Promise<boolean>
  /**
   * 把 data:URL 或 http(s) URL 的图片保存到用户选择的路径。
   * 返回最终保存路径；用户取消返回 null。
   * Image Preview Overlay: 顶部下载按钮通过它落盘本地图片。
   */
  'system.saveImage': (args: {
    /** 图片源：data:URL 或 http(s) URL */
    url: string
    /** 建议的文件名（不含目录） */
    suggestedName?: string
  }) => Promise<string | null>
  /**
   * Tray: 取走主进程暂存的托盘命令（take-once，取完即清）。
   *
   * 只在"托盘菜单把已关闭的窗口重新拉起来"时非空：那一刻渲染层还不存在，
   * push 无处可发，主进程先存着，等渲染层起来自己来拿。
   */
  'system.takeTrayCommand': () => Promise<TrayCommandId | null>
  /**
   * Tray: 上报托盘菜单的门控条件（路由 / 工作区变化时调）。
   *
   * 主进程只存不算——菜单在右键弹出的那一刻才用最新值重建，
   * 所以这里漏报一次最多让某一项的启用状态慢一拍，不会留下错误的常驻菜单。
   */
  'system.setTrayContext': (args: TrayContext) => Promise<void>
  /**
   * File Context Menu: 用系统默认应用打开文件或目录（shell.openPath）。
   * path 必须是已解析的绝对路径（由调用方通过 fs.resolveFileReference 取得）。
   */
  'system.openPath': (args: { path: string }) => Promise<void>
  /**
   * File Context Menu: 在 Finder / 资源管理器中定位（选中）文件（shell.showItemInFolder）。
   * 与 session.revealInFolder 同源，区别只是这里收任意绝对路径而非 sessionId。
   */
  'system.showItemInFolder': (args: { path: string }) => Promise<void>
  /**
   * File Context Menu: 查询能打开该文件的应用列表（macOS「打开方式」）。
   * 仅 darwin 通过 Launch Services 查询；其它平台返回空数组，调用方据此隐藏菜单项。
   */
  'system.openWithApps': (args: { path: string }) => Promise<OpenWithApp[]>
  /**
   * File Context Menu: 用指定应用打开文件（`open -a <appPath> <filePath>`，仅 darwin）。
   */
  'system.openWithApp': (args: { filePath: string; appPath: string }) => Promise<void>
  /**
   * Open With: 读回用户在聊天顶部「打开方式」选择器里选中的应用。
   * 存在 app_state 表（key=OPEN_WITH_APP），值为 OpenWithApp 的 JSON；未选过返回 null（=系统默认）。
   */
  'system.getOpenWithApp': () => Promise<OpenWithApp | null>
  /**
   * Open With: 持久化用户选择的全局打开方式应用。
   */
  'system.setOpenWithApp': (args: { app: OpenWithApp | null }) => Promise<void>
  /**
   * Open With: 列出系统已安装的应用（扫 /Applications + ~/Applications 下的 .app）。
   * 全局「打开方式」选择器用它——不依赖具体文件，下拉始终可用。
   * 仅 darwin 返回非空；其它平台返回空数组。
   */
  'system.listApplications': () => Promise<OpenWithApp[]>
}

/** macOS「打开方式」子菜单里的一项：应用名 + .app 包路径 + 图标 */
export interface OpenWithApp {
  name: string
  path: string
  /** 应用图标 PNG（base64 data URL）。listApplications 会带上；按文件查的子菜单可选 */
  icon?: string
}
