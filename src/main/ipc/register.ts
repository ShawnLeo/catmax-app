import { logger } from '../service/logger'

import { registerSettingsHandlers } from './domains/settings'
import { registerSystemHandlers } from './domains/system'
import { registerWorkspaceHandlers } from './domains/workspace'

const log = logger.domain('ipc-register')

/** 所有 handler 的类型聚合（未来扩展时合并新 domain） */
export type AllHandlers = unknown // 占位：在 Plan 2 加 backend、session 等时替换

export async function registerAllHandlers(): Promise<void> {
  registerWorkspaceHandlers()
  registerSettingsHandlers()
  registerSystemHandlers()
  log.info('all handlers registered')
}
