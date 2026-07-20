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
}
