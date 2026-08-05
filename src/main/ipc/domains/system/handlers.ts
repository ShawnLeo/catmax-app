import { Buffer } from 'node:buffer'
import { writeFileSync } from 'node:fs'

import { parseSystemProxy } from '@main/backend/proxy-env'
import { ctx } from '@main/context'
import { setTrayContext as applyTrayContext, takePendingTrayCommand } from '@main/tray'
import type {
  DetectedSystemProxy,
  OpenDialogArgs,
  PlatformInfo,
  TrayCommandId,
  TrayContext,
} from '@shared/ipc/system'
import { dialog, net, shell } from 'electron'

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

/** 窗口控制：切换始终置顶，并把主进程中的真实状态返回给渲染层。 */
export const windowToggleAlwaysOnTop = async (): Promise<boolean> => {
  const win = ctx.getMainWindow()
  if (!win) return false
  win.setAlwaysOnTop(!win.isAlwaysOnTop())
  return win.isAlwaysOnTop()
}

/** 窗口控制：检查是否始终置顶。 */
export const windowIsAlwaysOnTop = async (): Promise<boolean> => {
  return ctx.getMainWindow()?.isAlwaysOnTop() ?? false
}

/**
 * Tray: 渲染层启动时来取"窗口是被托盘菜单拉起来的"这条命令。
 * take-once 语义，取完主进程侧就清空，避免下次窗口重建时重放旧命令。
 */
export const takeTrayCommand = async (): Promise<TrayCommandId | null> => {
  return takePendingTrayCommand()
}

/**
 * Tray: 渲染层上报托盘菜单的门控条件（路由 / 工作区 / 登录态变化时）。
 * 只存不算——菜单在右键弹出那一刻才用最新值重建（见 main/tray.ts 的 buildMenu）。
 */
export const setTrayContext = async (args: TrayContext): Promise<void> => {
  applyTrayContext(args)
}

/**
 * 保存图片到用户选择的路径。
 *
 * Image Preview Overlay 顶部下载按钮入口。支持两种来源：
 * - data:URL（base64）：直接解码写盘，无网络依赖。
 * - http(s) URL：走 Electron net 拉取再流式写盘，避免 renderer CORS / blob 大小限制。
 *
 * 流程：先弹 showSaveDialog 让用户选路径（默认名用 suggestedName 或从 URL 推断），
 * 取消返回 null；保存成功返回最终路径。
 */
export const saveImage = async (args: {
  url: string
  suggestedName?: string
}): Promise<string | null> => {
  const win = ctx.getMainWindow()
  const { url, suggestedName } = args

  // 推断默认文件名：显式建议 > data:URL MIME > URL 路径 > 兜底 image
  const defaultName = suggestedName || inferImageName(url)

  const result = await dialog.showSaveDialog(win!, {
    title: '保存图片',
    defaultPath: defaultName,
    filters: [
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  })
  if (result.canceled || !result.filePath) return null

  if (url.startsWith('data:')) {
    // data:URL：解析 base64 payload 直接写盘（无网络依赖）
    const parsed = parseDataUrl(url)
    if (!parsed) throw new Error('无法解析 data:URL')
    writeFileSync(result.filePath, parsed.data)
    return result.filePath
  }

  // http(s) URL：走 Electron net 拉取整个 buffer 再写盘。
  // 一次性写而不是流式——图片通常不大，省掉临时文件的复杂度。
  const response = await net.fetch(url)
  if (!response.ok) {
    throw new Error(`下载失败：HTTP ${response.status}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  writeFileSync(result.filePath, buffer)
  return result.filePath
}

/** 从 data:URL 解析出 MIME 与二进制数据 */
function parseDataUrl(url: string): { mime: string; data: Buffer } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url)
  if (!match) return null
  const mime = match[1] ?? 'image/png'
  const isBase64 = Boolean(match[2])
  const payload = match[3] ?? ''
  const data = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload))
  return { mime, data }
}

/** 从 url / data:URL 推断图片文件名（带扩展名） */
function inferImageName(url: string): string {
  if (url.startsWith('data:')) {
    const mime = /^data:([^;,]+)/.exec(url)?.[1] ?? 'image/png'
    const ext = mime.split('/')[1]?.split('+')[0] ?? 'png'
    return `image.${ext}`
  }
  try {
    const u = new URL(url)
    const base = u.pathname.split('/').pop()?.split('?')[0] ?? ''
    // 有扩展名直接用，否则按常见图片兜底
    if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(base)) return base
    return `${base || 'image'}.png`
  } catch {
    return 'image.png'
  }
}
