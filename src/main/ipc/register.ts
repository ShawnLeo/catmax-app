import { logger } from '../service/logger'

import { registerBackendHandlers } from './domains/backend'
import { registerFsHandlers } from './domains/fs'
import { registerGitHandlers } from './domains/git'
import { registerMcpHandlers, syncMcpOnStartupHandler } from './domains/mcp'
import { registerPtyHandlers } from './domains/pty'
import { registerSessionHandlers } from './domains/session'
import { registerSettingsHandlers } from './domains/settings'
import { registerSkillsHandlers, syncSkillsOnStartup } from './domains/skills'
import { registerSystemHandlers } from './domains/system'
import { registerWorkspaceHandlers } from './domains/workspace'

const log = logger.domain('ipc-register')

/** 所有 handler 的类型聚合（未来扩展时合并新 domain） */
export type AllHandlers = unknown // 占位：在 Plan 2 加 backend、session 等时替换

export async function registerAllHandlers(): Promise<void> {
  registerWorkspaceHandlers()
  registerSettingsHandlers()
  registerSystemHandlers()
  registerBackendHandlers()
  registerSessionHandlers()
  registerGitHandlers()
  registerFsHandlers()
  registerPtyHandlers()
  registerSkillsHandlers()
  registerMcpHandlers()
  log.info('all handlers registered')
  // Unified Skill Center: 补推被关掉的技能。不 await——codex 首次调用会 spawn
  // app-server，拿它挡住启动会让窗口白等好几秒。
  void syncSkillsOnStartup()
  // Unified MCP Server Center: 同理补推 MCP 开关。同样不 await。
  void syncMcpOnStartupHandler()
}
