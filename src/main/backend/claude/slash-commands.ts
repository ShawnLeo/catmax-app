/**
 * Claude 斜杠命令表的过滤与归一化。
 *
 * 数据源是 SDK 的 `initializationResult().commands`——它把三样东西混在同一个
 * 数组里返回（本机实测 cwd=catmax-app 时共 79 条）：
 *   - 内置命令 42 条，描述无后缀
 *   - 用户 Skill 36 条（~/.claude/skills/），描述以 `(user)` 结尾
 *   - 项目 Skill 1 条（<cwd>/.claude/skills/），描述以 `(project)` 结尾
 *
 * 所以拿 Skill 不需要自己扫磁盘，但**必须过滤**：直接把这 79 条丢给 UI，
 * 里面会混进一批在 catmax 里按下去就出问题的命令，见 DENIED 。
 *
 * 纯函数，不碰 SDK 也不碰进程——过滤规则是这里最需要被测试钉住的东西。
 */
import type { SlashCommandInfo, SlashCommandSource } from '@shared/backend/slash-commands'

/**
 * 不放行的命令。
 *
 * 采用 denylist 而不是 allowlist：会出事的是**有限且稳定**的一组——它们的共同点
 * 是"改变了 catmax 也在管的状态"，而不是一个开放集合。这样 claude 新版本加的命令
 * 自动可用，不必跟着升级。
 *
 * 三类：
 *
 * 1. 跟 catmax 的状态管理打架。catmax 每个 turn 都在 StartTurnArgs 里传自己的
 *    model/effort，SDK 侧改完下一轮就被覆盖，而 UI 上的选择器还显示旧值——用户
 *    看到的是"改了没生效"且查不出原因。`/clear` 更狠：它换 session_id，
 *    catmax 的 backend_thread_id 映射当场断掉，会话再也发不出消息。
 *
 * 2. 终端专属。改终端 prompt bar 颜色、要求交互面板，在 GUI 里没有对应物。
 *    `/config` 实测在 SDK 下降级成打印一屏 `Usage: /config key=value …`，
 *    而且改的是 claude 自己的 settings.json，跟 catmax 设置页是两套。
 *
 * 3. 内部命令。服务端下发的 workflow 承接口，用户手动发毫无意义。
 */
const DENIED = new Set([
  // 1. 与 catmax 状态管理冲突
  'model',
  'effort',
  'fast',
  'clear',
  'rename',
  'config',
  // 2. 终端专属 / 无对应 UI
  'agents', // 描述里已自述 (removed)
  'color',
  'mcp',
  'reload-skills',
  'doctor',
  'ide',
  'terminal-setup',
  'vim',
  'login',
  'logout',
  'exit',
  'quit',
  // 3. 内部命令
  '__remote-workflow',
  'workflow-launch-exec',
])

/**
 * 太重、不适合从输入框一键触发的命令。
 *
 * 跟 DENIED 分开列是因为它们并不会**弄坏**什么，只是代价大到不该手滑触发：
 * `/batch` 会开 5–30 个 worktree agent 各自开一个 PR，`/code-review ultra` 走云端
 * 且计费。将来要放开的话，从这里删一行就行，跟"会出事"那组的判断不混在一起。
 */
const TOO_HEAVY = new Set(['batch', 'deep-research', 'loop', 'ultrareview'])

/** 弹层里描述只占一行，Skill 的 description 动辄 500+ 字符，必须截。 */
const MAX_DESCRIPTION_LENGTH = 120

/** SDK 给的原始命令形状（结构上等于 SDK 的 SlashCommand）。 */
export interface RawSlashCommand {
  name: string
  description?: string
  argumentHint?: string
  aliases?: string[]
}

/**
 * 从描述尾部剥离来源标记。
 *
 * SDK 没有 source 字段，来源只能从 `… (user)` / `… (project)` 这个后缀反推。
 * 认不出就归 builtin——宁可把一条 Skill 显示成内置命令，也不能因为 claude 改了
 * 描述格式就整张表报废。剥离后描述里不再挂着 `(user)`，否则每一条右边都拖个尾巴。
 */
function splitSource(description: string): { text: string; source: SlashCommandSource } {
  const match = /^(.*?)\s*\((user|project)\)\s*$/s.exec(description)
  if (!match) return { text: description, source: 'builtin' }
  return { text: match[1]!, source: match[2] as SlashCommandSource }
}

/** 压成一行并截断——description 里可能有换行（Skill 的触发条件常常分行写）。 */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= MAX_DESCRIPTION_LENGTH) return flat
  return `${flat.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`
}

/** 过滤 + 归一化 SDK 的原始命令表。 */
export function normalizeSlashCommands(raw: RawSlashCommand[]): SlashCommandInfo[] {
  const result: SlashCommandInfo[] = []
  for (const cmd of raw) {
    const name = cmd.name?.trim()
    if (!name) continue
    if (DENIED.has(name) || TOO_HEAVY.has(name)) continue
    // 内部命令统一按前缀挡一道：SDK 里已经有 __remote-workflow 这种写法，
    // 后续版本再加同类的不必等着补名单。
    if (name.startsWith('__')) continue

    const { text, source } = splitSource(cmd.description ?? '')
    const info: SlashCommandInfo = {
      name,
      description: oneLine(text),
      argumentHint: cmd.argumentHint?.trim() ?? '',
      source,
    }
    const aliases = cmd.aliases?.filter((a) => a.trim().length > 0)
    if (aliases && aliases.length > 0) info.aliases = aliases
    result.push(info)
  }
  return result
}
