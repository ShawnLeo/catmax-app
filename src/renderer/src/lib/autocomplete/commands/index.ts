/**
 * Composer Autocomplete: 斜杠命令按后端分表。
 *
 * 这个文件是「哪个后端有哪些斜杠命令」的完整答案。接新后端 = 新建一个
 * `commands/<backend>.ts` 导出一张表，再在下面 register 一行。
 *
 * 做成注册表而不是写死的 Record：BackendId 是 string（第三方 backend plugin 也
 * 能注册后端，见 src/shared/backend/plugin.ts），所以穷举不了；注册表还让将来
 * 「从 SDK 动态拉命令列表」可以直接覆盖某个后端的表，不用改 provider。
 */
import type { BackendId } from '@shared/constants'

import { CLAUDE_SLASH_COMMANDS } from './claude'
import { CODEX_SLASH_COMMANDS } from './codex'
import type { SlashCommandSpec } from './types'

const catalogs = new Map<BackendId, SlashCommandSpec[]>()

/** 注册（或整表替换）某个后端的斜杠命令。 */
export function registerSlashCommands(backendId: BackendId, specs: SlashCommandSpec[]): void {
  catalogs.set(backendId, specs)
}

/** 取某个后端的斜杠命令；后端未知或没注册过时返回空表（= 该后端没有斜杠命令）。 */
export function slashCommandsFor(backendId: BackendId | undefined): SlashCommandSpec[] {
  if (!backendId) return []
  return catalogs.get(backendId) ?? []
}

registerSlashCommands('claude', CLAUDE_SLASH_COMMANDS)
registerSlashCommands('codex', CODEX_SLASH_COMMANDS)

export type { SlashCommandSpec } from './types'
