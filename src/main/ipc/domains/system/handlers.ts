import { parseSystemProxy } from '@main/backend/proxy-env'
import { ctx } from '@main/context'
import type { DetectedSystemProxy, OpenDialogArgs, PlatformInfo } from '@shared/ipc/system'
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

/**
 * 检测当前系统的代理设置。
 * - macOS: 跑 `scutil --proxy` 解析
 * - Windows: 读注册表 HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings
 * - Linux: 读 HTTP_PROXY / HTTPS_PROXY 环境变量
 *
 * 检测不到时返回 enabled=false + source='none'。
 */
export const detectProxy = async (): Promise<DetectedSystemProxy> => {
  // Linux: 直接读 env
  if (process.platform === 'linux') {
    const url =
      process.env.HTTPS_PROXY ??
      process.env.https_proxy ??
      process.env.HTTP_PROXY ??
      process.env.http_proxy
    if (url) {
      return {
        enabled: true,
        url,
        bypass: process.env.NO_PROXY ?? process.env.no_proxy ?? null,
        source: 'linux-env',
      }
    }
    return { enabled: false, url: '', bypass: null, source: 'none' }
  }

  // macOS: 跑 scutil --proxy
  if (process.platform === 'darwin') {
    try {
      const { execSync } = await import('node:child_process')
      const output = execSync('scutil --proxy', { encoding: 'utf-8', timeout: 3000 })
      const parsed = parseSystemProxy(output)
      if (parsed) {
        return { ...parsed, source: 'macos-scutil' }
      }
      return { enabled: false, url: '', bypass: null, source: 'none' }
    } catch {
      return { enabled: false, url: '', bypass: null, source: 'none' }
    }
  }

  // Windows: 读注册表（reg query）
  if (process.platform === 'win32') {
    try {
      const { execSync } = await import('node:child_process')
      const regQuery = (key: string) =>
        execSync(
          `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ${key}`,
          {
            encoding: 'utf-8',
            timeout: 3000,
          },
        ).trim()
      const enableStr = regQuery('ProxyEnable')
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(enableStr)
      if (!enabled) {
        return { enabled: false, url: '', bypass: null, source: 'none' }
      }
      const serverStr = regQuery('ProxyServer')
      const m = serverStr.match(/ProxyServer\s+REG_SZ\s+(\S+)/)
      const host = m?.[1] ?? ''
      const bypassStr = regQuery('ProxyOverride')
      const bm = bypassStr.match(/ProxyOverride\s+REG_SZ\s+(\S*)/)
      const bypass = bm?.[1] || null
      const url = /^https?:\/\//.test(host) ? host : `http://${host}`
      return { enabled: true, url, bypass, source: 'windows-registry' }
    } catch {
      return { enabled: false, url: '', bypass: null, source: 'none' }
    }
  }

  return { enabled: false, url: '', bypass: null, source: 'none' }
}

/** 窗口控制：最小化 */
export const windowMinimize = async (): Promise<void> => {
  const win = ctx.getMainWindow()
  if (win) win.minimize()
}

/**
 * 窗口控制：最大化/还原。
 *
 * macOS 上 maximize() 只把窗口拉到工作区大小（保留菜单栏/Dock），
 * 绿色按钮"没有完全放大整个屏幕"的体验来自这里——
 * macOS 绿色按钮的原生语义是全屏，所以 darwin 走 setFullScreen。
 * Windows/Linux 保持 maximize。
 */
export const windowMaximize = async (): Promise<void> => {
  const win = ctx.getMainWindow()
  if (!win) return
  if (process.platform === 'darwin') {
    win.setFullScreen(!win.isFullScreen())
  } else if (win.isMaximized()) {
    win.unmaximize()
  } else {
    win.maximize()
  }
}

/** 窗口控制：关闭 */
export const windowClose = async (): Promise<void> => {
  const win = ctx.getMainWindow()
  if (win) win.close()
}

/** 窗口控制：检查是否最大化（macOS 上反映全屏状态，与 windowMaximize 对齐） */
export const windowIsMaximized = async (): Promise<boolean> => {
  const win = ctx.getMainWindow()
  if (!win) return false
  return process.platform === 'darwin' ? win.isFullScreen() : win.isMaximized()
}
