import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { is } from '@electron-toolkit/utils'
import { app, BrowserWindow, nativeImage, shell } from 'electron'

import { ctx } from './context'

/**
 * 解析 App 图标资源路径。
 *
 * resources/icon.png 是 512x512 猫咪图标。
 * dev 模式 app.getAppPath() = 项目根 → <root>/resources/icon.png；
 * packaged 模式 resources/ 被 asarUnpack 到 process.resourcesPath。
 * 用 app.getAppPath() 主路径 + process.resourcesPath 兜底，两个都找不到返回 undefined。
 */
function resolveIconPath(): string | undefined {
  const candidates = [
    join(app.getAppPath(), 'resources/icon.png'), // dev / packaged app root
    join(process.resourcesPath, 'icon.png'), // packaged asarUnpack 兜底
    join(__dirname, '../resources/icon.png'), // 旧路径兜底
  ]
  return candidates.find((p) => existsSync(p))
}

/**
 * 解析 preload 产物路径。
 *
 * electron-vite 在 package.json type: "module" 时输出 .mjs，否则输出 .js。
 * 两者都支持，避免 preload 加载失败导致 window.api 为 undefined。
 */
function resolvePreloadPath(): string {
  const dir = join(__dirname, '../preload')
  for (const filename of ['index.mjs', 'index.js']) {
    const candidate = join(dir, filename)
    if (existsSync(candidate)) return candidate
  }
  // fallback（让 electron 报具体错误）
  return join(dir, 'index.js')
}

export function createMainWindow(): BrowserWindow {
  const iconPath = resolveIconPath()
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : undefined

  // macOS：BrowserWindow 的 icon 选项对 Dock 图标无效（只影响 Win 任务栏）。
  // dev 模式跑的是 node_modules 里的 Electron.app，Dock 默认显示 Electron 图标，
  // 必须显式 app.dock.setIcon() 才能在 dev 下也看到猫咪图标。
  // （packaged 模式下 .icns 已是 app 图标，这里再设一次也无害。）
  if (icon && process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(icon)
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    frame: false, // 完全移除窗口框架
    autoHideMenuBar: true,
    title: 'Catmax',
    ...(icon ? { icon } : {}), // Windows 任务栏图标（macOS 见上面的 dock.setIcon）
    backgroundColor: '#18181b', // 与 dark theme --background 接近，避免白闪
    webPreferences: {
      preload: resolvePreloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  // 外部链接用系统浏览器打开，不在 App 内导航
  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    win.webContents.openDevTools()
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  ctx.registerWindow('main', win)
  return win
}
