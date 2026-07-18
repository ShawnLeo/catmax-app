import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { is } from '@electron-toolkit/utils'
import { BrowserWindow, shell } from 'electron'

import { ctx } from './context'

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
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'catmax',
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
