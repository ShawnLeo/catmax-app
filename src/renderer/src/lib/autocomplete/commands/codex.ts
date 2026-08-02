/**
 * Composer Autocomplete: codex 后端的斜杠命令。
 *
 * 跟 claude 的表是两种东西，别照着那边改：
 *
 *   - claude：`/compact` 是**文本**，发给 CLI，CLI 自己拦截并展开。命令表由
 *     `initializationResult().commands` 动态给出（含用户/项目 Skill），catmax 只做过滤。
 *   - codex：`/compact` 是**动作**，对应 `thread/compact/start` 这个 JSON-RPC。
 *     app-server 上**没有**列命令的接口（枚举里没有 `commands/list`），所以这张表
 *     只能手工维护，且会随 codex 版本漂移——护栏见 `.claude/skills/slash-command-audit`。
 *
 * 把 codex 的斜杠命令当文本发出去会被原样交给模型（用户看到模型茫然地问"你要我
 * 压缩什么"），所以每条都必须带 command，走 SuggestionItem.command 那条派发路径。
 *
 * **codex 的 skill 不在这张表里，也不该进来。** codex 把 skill 列表注入 system
 * prompt 由模型自行取用（`skills/list` 能读到，但那是给设置面板用的），没有
 * `/skill-name` 这条调用路径——放进来就正好是上面那个"当文本发出去"的坑。
 * 这跟 claude 把 skill 混进 commands 数组是完全不同的机制。
 */
import type { SlashCommandSpec } from './types'

export const CODEX_SLASH_COMMANDS: SlashCommandSpec[] = [
  {
    name: 'compact',
    description: '压缩当前对话为摘要，腾出上下文',
    source: 'builtin',
    // thread/compact/start。实测它会发出 turn/started + item/started——是一个
    // 完整的 turn，所以必须经 PerTurnCoordinator（详见 shared 的 TurnCommand）。
    commandId: 'compact',
  },
]
