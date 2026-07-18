/**
 * 主进程全局上下文。
 * 所有 service、db、manager 单例挂在这里，避免到处 new。
 *
 * 注意：DB 和 manager 在各自 Task 里实现，这里只是占位容器。
 * Task 8/10 会真的实例化 Database。
 */
import type { BrowserWindow } from 'electron'

import { logger } from './service/logger'

const log = logger.domain('context')

class Context {
  readonly windows = new Map<string, BrowserWindow>()

  // 在 Task 8/10 中填充：
  // db!: Database
  // settingsStore!: SettingsStore

  registerWindow(id: string, win: BrowserWindow): void {
    this.windows.set(id, win)
    win.on('closed', () => {
      this.windows.delete(id)
      log.info('window closed', id)
    })
  }

  getMainWindow(): BrowserWindow | undefined {
    return this.windows.get('main')
  }

  /** 向所有窗口广播事件（用于推送） */
  broadcast(channel: string, ...args: unknown[]): void {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, ...args)
      }
    }
  }
}

export const ctx = new Context()
