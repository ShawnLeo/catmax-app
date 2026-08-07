/**
 * 系统托盘（macOS 菜单栏 / Windows 通知区域）。
 *
 * 交互约定：左键单击激活主窗口，右键弹出菜单（打开应用 / 新建会话 / 设置 / 退出应用）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { PUSH } from '@shared/constants'
import { type TrayCommandId, type TrayContext } from '@shared/ipc/system'
import { app, Menu, nativeImage, nativeTheme, Tray, type NativeImage } from 'electron'

import { ctx } from './context'
import { logger } from './service/logger'
import { showMainWindow } from './window'

const log = logger.domain('tray')

// Tray 实例必须由模块持有。局部变量出了作用域会被 GC，图标随即从状态栏消失——
// 这是托盘功能最经典的"图标一闪就没"故障。
let tray: Tray | null = null

/**
 * Tray Command Handoff: 托盘点了"新建会话"/"设置"，但窗口是这次才建的。
 *
 * 那一刻渲染层还没加载完，更没订阅 push，直接 webContents.send 会石沉大海。
 * 所以先在这里暂存，渲染层启动时通过 system.takeTrayCommand 主动来取。
 * 窗口本来就活着的场景不走这里，直接 push（见 dispatchTrayCommand）。
 */
let pendingCommand: TrayCommandId | null = null

export function takePendingTrayCommand(): TrayCommandId | null {
  const command = pendingCommand
  pendingCommand = null
  return command
}

/**
 * Tray Gating: 渲染层上报的门控条件（见 shared/ipc/system.ts 的 TrayContext）。
 *
 * 初值 false 是安全侧：窗口还没起来 / 已经关掉时，"新建会话"本来就无处可去。
 */
let trayContext: TrayContext = { canCreateSession: false }

export function setTrayContext(next: TrayContext): void {
  trayContext = next
}

/**
 * 解析托盘图标资源。
 *
 * 路径兜底策略与 window.ts 的 resolveIconPath() 一致：dev 下 app.getAppPath() 是项目根，
 * packaged 下 resources/ 被 asarUnpack 到 process.resourcesPath。
 */
function resolveTrayAsset(filename: string): string | undefined {
  const candidates = [
    join(app.getAppPath(), 'resources/tray', filename),
    join(process.resourcesPath, 'tray', filename),
    // Hot Update: 用 import.meta.dirname 而不是 bundler 注入的 __dirname，理由见 window.ts 顶部。
    join(import.meta.dirname, '../resources/tray', filename),
  ]
  return candidates.find((p) => existsSync(p))
}

/**
 * 托盘图标不能复用 resources/icon.png（1024 彩色图），两个平台的要求完全不同：
 *
 * - macOS 要模板图（纯黑 + alpha），由系统按菜单栏明暗自动反色。彩色图不会反色，
 *   深色菜单栏下会糊成一坨。文件名以 Template 结尾时 Electron 自动识别，这里仍显式
 *   setTemplateImage 兜底。@2x/@3x 放同目录同名，createFromPath 自动挑对应缩放。
 * - Windows 没有模板图机制，不会反色，只能按任务栏明暗预先备两套 .ico
 *   （深色任务栏用白猫，浅色任务栏用黑猫），跟着 nativeTheme 切。
 */
function loadTrayImage(): NativeImage | null {
  const filename =
    process.platform === 'darwin'
      ? 'trayTemplate.png'
      : nativeTheme.shouldUseDarkColors
        ? 'tray-on-dark.ico'
        : 'tray-on-light.ico'

  const assetPath = resolveTrayAsset(filename)
  if (!assetPath) {
    log.warn('tray icon asset not found:', filename)
    return null
  }

  const image = nativeImage.createFromPath(assetPath)
  if (image.isEmpty()) {
    log.warn('tray icon asset failed to decode:', assetPath)
    return null
  }
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}

function dispatchTrayCommand(command: TrayCommandId): void {
  const { win, created } = showMainWindow()
  if (created) {
    pendingCommand = command
    return
  }
  win.webContents.send(PUSH.TRAY_COMMAND, { command })
}

/**
 * Tray Gating: 每次右键弹出时重建菜单，而不是启动时建一次留着。
 *
 * 菜单项的启用状态取决于登录态和当前路由，两者都会在 App 运行期间变。
 * 与其订阅每一处变化再 setContextMenu，不如在唯一会被看见的那一刻现算——
 * 弹出瞬间读到的状态必然是最新的，也就不存在"忘了在某个入口刷新菜单"这类漏。
 *
 * 门控规则：
 * - 未登录：路由守卫会把一切导航拦回 /login，所以「新建会话」「设置」点了也只会
 *   弹到登录页，一律置灰。用 enabled: false 而不是隐藏——菜单项数量保持稳定，
 *   用户看得见功能存在、只是当前不可用，不会以为版本缺功能。
 * - 「退出应用」始终可点：它不经过渲染层，未登录时也必须留给用户退出的路，
 *   否则托盘上只剩一个打不开有效界面的图标。
 *
 * 还要额外看窗口是否活着：macOS 关窗后进程不退，trayContext 会停在关窗前那一刻的值，
 * 用户在 /chat 关掉窗口后右键仍会看到「新建会话」可点，点下去却是新窗口从欢迎页启动，
 * 命令落到一个还没有工作区的页面上。窗口不在就一律当作不能建会话。
 */
function buildMenu(): Menu {
  const loggedIn = ctx.authStore.getStatus().loggedIn
  const windowAlive = !!ctx.getMainWindow()

  return Menu.buildFromTemplate([
    {
      label: '打开应用',
      click: () => {
        showMainWindow()
      },
    },
    { type: 'separator' },
    {
      label: '新建会话',
      enabled: loggedIn && windowAlive && trayContext.canCreateSession,
      click: () => dispatchTrayCommand('session.new'),
    },
    { label: '设置', enabled: loggedIn, click: () => dispatchTrayCommand('app.go-settings') },
    { type: 'separator' },
    {
      label: '退出应用',
      // 必须是 app.quit() 而不是 app.exit()——quit 会走 index.ts 里已有的 before-quit，
      // 那里负责 dispose 后端、停 Protocol Bridge、杀掉所有 pty，最后才 app.exit(0)。
      // 直接 exit 会把这些子进程留成孤儿。
      click: () => {
        app.quit()
      },
    },
  ])
}

export function createTray(): Tray | null {
  if (tray) return tray

  const image = loadTrayImage()
  if (!image) {
    log.warn('tray disabled: no usable icon')
    return null
  }

  tray = new Tray(image)
  tray.setToolTip('Catmax')

  // 关键：不调 tray.setContextMenu()。一旦设了 context menu，Windows 上左键单击也会
  // 弹菜单、拿不到 click 事件，macOS 上 click/double-click 会失效
  // （electron/electron#24196、#5058）。改成两个事件里手动处理，两个平台行为才一致。
  tray.on('click', () => {
    showMainWindow()
  })
  tray.on('right-click', () => {
    tray?.popUpContextMenu(buildMenu())
  })

  // Windows 任务栏在浅色/深色之间切换时换一套图标；macOS 是模板图，系统自己反色，不用管。
  if (process.platform !== 'darwin') {
    nativeTheme.on('updated', () => {
      const next = loadTrayImage()
      if (next && tray && !tray.isDestroyed()) tray.setImage(next)
    })
  }

  log.info('tray created')
  return tray
}
