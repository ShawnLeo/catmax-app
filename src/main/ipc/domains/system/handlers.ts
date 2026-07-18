import { ctx } from '@main/context'
import type { OpenDialogArgs, PlatformInfo } from '@shared/ipc/system'
import { dialog, shell } from 'electron'

export const getPlatformInfo = async (): Promise<PlatformInfo> => {
  return {
    platform: process.platform as PlatformInfo['platform'],
    arch: process.arch as PlatformInfo['arch'],
    osVersion: process.getSystemVersion(),
    appVersion: process.env['npm_package_version'] ?? '0.0.0',
    electronVersion: process.versions.electron,
  }
}

export const openDialog = async (args: OpenDialogArgs) => {
  const win = ctx.getMainWindow()
  const options: Electron.OpenDialogOptions = {
    properties: args.properties ?? ['openDirectory'],
  }
  if (args.title !== undefined) options.title = args.title
  if (args.defaultPath !== undefined) options.defaultPath = args.defaultPath
  const result = await dialog.showOpenDialog(win!, options)
  return { canceled: result.canceled, filePaths: result.filePaths }
}

export const openExternal = async (args: { url: string }): Promise<void> => {
  await shell.openExternal(args.url)
}
