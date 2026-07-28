import { is } from '@electron-toolkit/utils'
import { app, BrowserWindow } from 'electron'
import fixPath from 'fix-path'

import { ctx } from './context'
import { registerAllHandlers } from './ipc/register'
import { logger } from './service/logger'
import { createMainWindow } from './window'

const log = logger.domain('main')

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
  ctx.backendManager.applySettings(ctx.settingsStore.load())
  log.info('database + settings ready')

  registerAllHandlers()

  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('before-quit', async (event) => {
  event.preventDefault()
  await ctx.backendManager.dispose()
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
