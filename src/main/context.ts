/**
 * 主进程全局上下文。
 * 所有 service、db、manager 单例挂在这里，避免到处 new。
 */
import type { BrowserWindow } from 'electron'

import { BackendManager } from './backend/manager'
import { DatabaseService } from './service/database'
import { logger } from './service/logger'
import { PtyManager } from './service/pty-manager'
import { SettingsStore } from './service/settings-store'

const log = logger.domain('context')

class Context {
  readonly windows = new Map<string, BrowserWindow>()
  readonly db: DatabaseService
  readonly settingsStore: SettingsStore
  readonly backendManager: BackendManager
  readonly ptyManager: PtyManager

  constructor() {
    this.db = new DatabaseService()
    this.settingsStore = new SettingsStore()
    this.backendManager = new BackendManager()
    this.ptyManager = new PtyManager({
      onData: (id, data) => {
        this.broadcast('pty:data', { id, data })
      },
      onExit: (id, exitCode) => {
        this.broadcast('pty:exit', { id, exitCode })
      },
    })
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
