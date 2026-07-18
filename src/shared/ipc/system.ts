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

export type SystemHandlers = {
  'system.platformInfo': () => Promise<PlatformInfo>
  'system.openDialog': (args: OpenDialogArgs) => Promise<OpenDialogResult>
  'system.openExternal': (args: { url: string }) => Promise<void>
}
