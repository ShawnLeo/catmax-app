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
}
