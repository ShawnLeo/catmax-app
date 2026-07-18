/**
 * 主进程全局上下文。
 * 所有 service、db、manager 单例挂在这里，避免到处 new。
 */
import type { BrowserWindow } from 'electron'

import { DatabaseService } from './service/database'
import { logger } from './service/logger'
import { SettingsStore } from './service/settings-store'

const log = logger.domain('context')

class Context {
  readonly windows = new Map<string, BrowserWindow>()
  readonly db: DatabaseService
  readonly settingsStore: SettingsStore

  constructor() {
    this.db = new DatabaseService()
    this.settingsStore = new SettingsStore()
  }

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
