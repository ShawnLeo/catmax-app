import { app, BrowserWindow } from 'electron'

import { ctx } from './context'
import { registerAllHandlers } from './ipc/register'
import { logger } from './service/logger'
import { createMainWindow } from './window'

const log = logger.domain('main')

void app.whenReady().then(async () => {
  log.info('app ready', app.getVersion())

  // 初始化持久化
  ctx.db.migrate()
  ctx.settingsStore.load()
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
