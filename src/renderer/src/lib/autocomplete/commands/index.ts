/**
 * Composer Autocomplete: 斜杠命令按后端分表。
 *
 * 这个文件是「哪个后端有哪些斜杠命令」的完整答案。接新后端 = 新建一个
 * `commands/<backend>.ts` 导出一张兜底表，再在下面 register 一行。
 *
 * 做成注册表而不是写死的 Record：BackendId 是 string（第三方 backend plugin 也
 * 能注册后端，见 src/shared/backend/plugin.ts），所以穷举不了；更重要的是
 * **动态列表要能整表替换掉兜底表**——claude 的真实命令表来自 SDK，按 cwd 不同
 * （项目级 Skill 来自 <cwd>/.claude/skills/），由 stores/slash-commands.ts 预取后
 * 调 registerSlashCommands 灌进来，provider 一行不用改。
 */
import type { SlashCommandInfo } from '@shared/backend/slash-commands'
import type { BackendId } from '@shared/constants'

import { CLAUDE_FALLBACK_COMMANDS } from './claude'
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

/**
 * 把 main 送来的命令表转成 renderer 的 spec。
 *
 * 差别只有图标：IPC 传不了 Vue 组件，所以图标在 renderer 侧按 source 补
 * （见 providers/slash-command.ts）。argumentHint 在 IPC 契约里是必填空串，
 * 这里转回 undefined——provider 用「有没有 argumentHint」判断要不要补尾随空格，
 * 空串必须等价于没有。
 */
export function toSlashCommandSpecs(infos: SlashCommandInfo[]): SlashCommandSpec[] {
  return infos.map((info) => ({
    name: info.name,
    description: info.description,
    ...(info.argumentHint ? { argumentHint: info.argumentHint } : {}),
    ...(info.aliases && info.aliases.length > 0 ? { aliases: info.aliases } : {}),
    source: info.source,
  }))
}

registerSlashCommands('claude', CLAUDE_FALLBACK_COMMANDS)
registerSlashCommands('codex', CODEX_SLASH_COMMANDS)

export type { SlashCommandSpec } from './types'
