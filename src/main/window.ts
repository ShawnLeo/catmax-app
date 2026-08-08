import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { is } from '@electron-toolkit/utils'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH } from '@shared/constants'
import { app, BrowserWindow, nativeImage, screen, shell, type Rectangle } from 'electron'

import { ctx } from './context'

/**
 * Hot Update: 用 ESM 原生的 import.meta.dirname，不依赖 bundler 注入的 __dirname。
 *
 * electron-vite 是否注入 `const __dirname = import.meta.dirname` 会随 external/bundle
 * 配置变化——Phase 0 实测过一次：改了 externalizeDepsPlugin 的 exclude 之后注入消失，
 * 应用启动即 `ReferenceError: __dirname is not defined`，窗口都建不出来。
 *
 * 这个值同时是热更新的地基：侧载执行时它指向 versions/<n>/main，
 * 于是下面的 preload / renderer 相对路径自动跟到同一个版本目录（设计文档 §5.5）。
 * 约定：它只用于定位 out/ 内部的产物；访问 app bundle 内的资源一律走
 * app.getAppPath() / process.resourcesPath，那些东西不参与热更新。
 */
const moduleDir = import.meta.dirname

/**
 * 解析 App 图标资源路径。
 *
 * resources/icon.png 是 1024x1024 猫咪图标，按 Apple 图标网格绘制：
 * 深色圆角方块只占 824/1024，四周留 100px 透明边距（详见 build/icon.icns 的同款母版）。
 * dev 模式 app.getAppPath() = 项目根 → <root>/resources/icon.png；
 * packaged 模式 resources/ 被 asarUnpack 到 process.resourcesPath。
 * 用 app.getAppPath() 主路径 + process.resourcesPath 兜底，两个都找不到返回 undefined。
 */
function resolveIconPath(): string | undefined {
  const candidates = [
    join(app.getAppPath(), 'resources/icon.png'), // dev / packaged app root
    join(process.resourcesPath, 'icon.png'), // packaged asarUnpack 兜底
    join(moduleDir, '../resources/icon.png'), // 旧路径兜底
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
  const dir = join(moduleDir, '../preload')
  for (const filename of ['index.mjs', 'index.js']) {
    const candidate = join(dir, filename)
    if (existsSync(candidate)) return candidate
  }
  // fallback（让 electron 报具体错误）
  return join(dir, 'index.js')
}

/** 至少保留这么多标题栏在屏幕内，确保用户始终能把窗口拖回来。 */
const MIN_VISIBLE_WINDOW_EDGE = 80
const WINDOW_STATE_SAVE_DELAY_MS = 300

function intersectArea(a: Rectangle, b: Rectangle): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return width * height
}

/**
 * Window State Persistence: 恢复边界前对照当前显示器拓扑修正。
 * 外接屏被拔掉时旧坐标可能完全不可见，此时回到主屏；仍在某块屏幕上时只收进工作区。
 */
function restoreBounds(saved: Rectangle | null): Rectangle {
  if (!saved) {
    const workArea = screen.getPrimaryDisplay().workArea
    const width = Math.min(1280, workArea.width)
    const height = Math.min(800, workArea.height)
    return {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width,
      height,
    }
  }

  const displays = screen.getAllDisplays()
  const display = displays.find((item) => intersectArea(saved, item.workArea) > 0)
  const workArea = (display ?? screen.getPrimaryDisplay()).workArea
  const width = Math.max(MIN_WINDOW_WIDTH, Math.min(saved.width, workArea.width))
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.min(saved.height, workArea.height))

  if (!display) {
    return {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width,
      height,
    }
  }

  return {
    x: Math.min(
      workArea.x + workArea.width - MIN_VISIBLE_WINDOW_EDGE,
      Math.max(workArea.x - width + MIN_VISIBLE_WINDOW_EDGE, saved.x),
    ),
    y: Math.min(
      workArea.y + workArea.height - MIN_VISIBLE_WINDOW_EDGE,
      Math.max(workArea.y, saved.y),
    ),
    width,
    height,
  }
}

export function createMainWindow(): BrowserWindow {
  const iconPath = resolveIconPath()
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : undefined
  const savedState = ctx.settingsStore.load().windowState
  const bounds = restoreBounds(savedState)

  // App Icon: macOS 下 BrowserWindow 的 icon 选项对 Dock 图标无效（只影响 Win 任务栏）。
  // dev 模式跑的是 node_modules 里的 Electron.app，Dock 默认显示 Electron 图标，
  // 必须显式 app.dock.setIcon() 才能在 dev 下也看到猫咪图标。
  //
  // 但 packaged 模式必须跳过：setIcon 会把 Dock 图标替换成这张位图，绕开系统对
  // app bundle 图标的加工（macOS 26 会把 .icns 套进 Liquid Glass 容器再渲染），
  // 导致运行时的 Dock 图标和 Finder / 启动台里看到的不是同一个。
  // packaged 下 Contents/Resources/icon.icns 已经是 app 图标，交给系统即可。
  if (icon && is.dev && process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(icon)
  }

  const win = new BrowserWindow({
    ...bounds,
    // Narrow Window: 下限按手机竖屏视口取（见 shared/constants）。渲染层的面板最小宽度
    // 会跟着窗口一起让步，所以缩到这个尺寸时布局仍然成立，不会溢出到窗口外。
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    frame: false, // 完全移除窗口框架
    autoHideMenuBar: true,
    alwaysOnTop: savedState?.alwaysOnTop ?? false,
    title: 'Catmax',
    ...(icon ? { icon } : {}), // Windows 任务栏图标（macOS 见上面的 dock.setIcon）
    // 左侧栏用带 alpha 的主题色透出桌面；其余渲染区自己铺满实色背景。
    // macOS 的 under-window 材质只作轻微柔化，不改变侧栏的主题色层级。
    transparent: true,
    backgroundColor: '#00000000',
    ...(process.platform === 'darwin'
      ? { vibrancy: 'under-window' as const, visualEffectState: 'active' as const }
      : {}),
    webPreferences: {
      preload: resolvePreloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.on('ready-to-show', () => {
    win.show()
    if (savedState?.fullScreen) {
      win.setFullScreen(true)
    } else if (savedState?.maximized) {
      win.maximize()
    }
  })

  // Window State Persistence: 高频 move/resize 合并写盘；关闭时同步 flush，避免丢最后状态。
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const saveWindowState = (): void => {
    if (win.isDestroyed()) return
    const normalBounds = win.getNormalBounds()
    ctx.settingsStore.update({
      windowState: {
        ...normalBounds,
        maximized: win.isMaximized(),
        fullScreen: win.isFullScreen(),
        alwaysOnTop: win.isAlwaysOnTop(),
      },
    })
  }
  const scheduleWindowStateSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveWindowState()
    }, WINDOW_STATE_SAVE_DELAY_MS)
  }
  win.on('move', scheduleWindowStateSave)
  win.on('resize', scheduleWindowStateSave)
  win.on('maximize', scheduleWindowStateSave)
  win.on('unmaximize', scheduleWindowStateSave)
  win.on('enter-full-screen', scheduleWindowStateSave)
  win.on('leave-full-screen', scheduleWindowStateSave)
  win.on('always-on-top-changed', scheduleWindowStateSave)
  win.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    saveWindowState()
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
    void win.loadFile(join(moduleDir, '../renderer/index.html'))
  }

  ctx.registerWindow('main', win)
  return win
}

export interface ShowMainWindowResult {
  win: BrowserWindow
  /** true = 窗口是这次新建的，渲染层还没就绪，此刻广播过去的 push 会丢。 */
  created: boolean
}

/**
 * Tray / Single Instance: 把主窗口带到前台，是"点托盘图标"和"重复启动 App"的共同落点。
 *
 * 要覆盖三种状态，缺一种就会表现成"点了没反应"：
 * - 已销毁：macOS 下 window-all-closed 不 quit，关掉窗口后进程还活着，只能重建；
 * - 最小化：show() 对最小化窗口无效，必须先 restore()；
 * - 隐藏 / 失焦：show() + focus()。
 *
 * macOS 还要额外一步：App 整体在后台时 win.focus() 只会让窗口在自己 App 内获得焦点，
 * 不会把 App 切到前台，必须 app.focus({ steal: true })（steal 仅 macOS 支持）。
 */
export function showMainWindow(): ShowMainWindowResult {
  const existing = ctx.getMainWindow()
  if (!existing || existing.isDestroyed()) {
    return { win: createMainWindow(), created: true }
  }

  if (existing.isMinimized()) existing.restore()
  if (!existing.isVisible()) existing.show()
  existing.focus()
  if (process.platform === 'darwin') app.focus({ steal: true })

  return { win: existing, created: false }
}
