import { is } from '@electron-toolkit/utils'
import { app, BrowserWindow } from 'electron'
import fixPath from 'fix-path'

import { ctx } from './context'
import { registerAllHandlers } from './ipc/register'
import { bridgeManager } from './protocol/manager'
import { logger } from './service/logger'
import { cleanupWarmupTranscripts } from './service/warmup-cleanup'
import { createTray } from './tray'
import { createMainWindow, showMainWindow } from './window'

const log = logger.domain('main')

// Single Instance: 第二个实例直接退出，把已有窗口带到前台。
// 除了体验问题，更重要的是两个进程会同时打开同一个 sqlite、抢同一个 Protocol Bridge 端口。
// 用 app.exit(0) 而不是 app.quit()：quit 会触发下面的 before-quit 去 dispose 后端和 bridge，
// 而这个副本压根没启动过它们，跑那套清理只会误伤第一个实例正在用的资源。
// 注意 ESM 的 import 已经先跑完了，ctx 构造时 sqlite 已被打开——但这个副本毫秒级就退出，
// 且 better-sqlite3 是 WAL 模式，短暂的并发打开是安全的。
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}

app.on('second-instance', () => {
  showMainWindow()
})

// 启用 Chrome DevTools Protocol (CDP) 远程调试。
// 必须在 app.whenReady() 之前调用——Chromium 在 renderer 初始化前读取这些 switch。
// 仅 dev 模式开启，避免在打包产物里暴露 CDP endpoint。
// 用法：启动后 curl http://127.0.0.1:9223/json/version 能看到 webSocketDebuggerUrl，
// chrome-devtools MCP 用 --browserUrl=http://127.0.0.1:9223 即可驱动渲染层。
if (is.dev) {
  app.commandLine.appendSwitch('remote-debugging-port', '9223')
  // Chromium M126+ 强制校验 WebSocket Origin 头，puppeteer 系客户端（含 chrome-devtools-mcp）
  // 不带 Origin 头会被 400 拒绝。开 dev 调试时必须放通。
  app.commandLine.appendSwitch('remote-allow-origins', '*')
}

// macOS GUI app 的 PATH 阉割修复。
// 从 Dock/Finder 启动的 GUI 进程，PATH 通常只有 /usr/bin:/bin:...，
// 不含 Homebrew 的 /opt/homebrew/bin 或 /usr/local/bin → claude/codex 子进程
// 跑 git/gh/node 等会 "command not found"。fix-path 读登录 shell 的完整 PATH 补回。
// 必须在 spawn 任何后端子进程之前调用（whenReady 内最早处即可）。
fixPath()

void app.whenReady().then(async () => {
  log.info('app ready', app.getVersion())
  log.info('PATH after fix-path:', process.env.PATH)

  // 初始化持久化
  ctx.db.migrate()
  ctx.backendManager.recoverInterruptedTurns()
  ctx.settingsStore.load()
  // 把 settings.json 里的 defaultBackend / backendPaths 注入到 BackendManager。
  // 关键：必须在 createMainWindow() 之前——否则渲染层 onMounted 里的
  // backend.current() / session.reconcile() 会读到默认的 'codex'，
  // 触发 CodexAdapter.initialize() 的 30s 握手超时（Bug: claude 用户发消息卡死）。
  // Protocol Bridge: 先把桥起起来——codex 的启动参数要用桥的端口和 token，
  // 桥没监听就拿到空值，codex 会按用户自己的 config.toml 走（等价于桥没开）。
  const startupSettings = ctx.settingsStore.load()
  try {
    await bridgeManager.applySettings(startupSettings.protocolBridge)
  } catch (e) {
    log.warn('protocol bridge failed to start:', e)
  }
  ctx.backendManager.applySettings(startupSettings)
  log.info('database + settings ready')

  registerAllHandlers()

  // Warmup Transcript: 清掉上次被强杀时留下的预热残留（文件 + 已入库的记录）。
  // 必须在 createMainWindow 之前 await——渲染层 onMounted 里就会 reconcile，
  // 晚一步的话那条 "Session warmup" 已经被读进侧边栏了。
  // 失败不阻塞启动：扫描层本来就会跳过预热 transcript，清理只是顺手收垃圾。
  try {
    await cleanupWarmupTranscripts()
  } catch (e) {
    log.warn('warmup transcript cleanup failed:', e)
  }

  createMainWindow()

  // Tray: 必须在 whenReady 之后创建。图标资源缺失时 createTray 返回 null 并只打 warn，
  // 托盘是增强入口，没有它 App 照常可用，不该让启动失败。
  createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('before-quit', async (event) => {
  event.preventDefault()
  await ctx.backendManager.dispose()
  await bridgeManager.stop()
  ctx.ptyManager.killAll()
  app.exit(0)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 安全：阻止未知协议导航
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    const parsed = new URL(url)
    if (!parsed.protocol.startsWith('http') && parsed.protocol !== 'file:') {
      event.preventDefault()
    }
  })
})
