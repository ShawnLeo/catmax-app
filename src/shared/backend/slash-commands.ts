/**
 * 斜杠命令的跨进程契约。
 *
 * main 从后端拿到原始命令表 → 过滤、分组、截断 → 交给 renderer 直接渲染。
 * renderer 不做任何"这条能不能用"的判断：那是后端状态管理的一部分（哪些命令
 * 会跟 catmax 自己管的 model/effort/session 打架），只有 main 知道。
 */

/**
 * 命令来源。
 *
 * claude 的 SDK 把内置命令和 Skill 混在同一个数组里返回，唯一的来源线索是
 * description 末尾的 `(user)` / `(project)` 后缀——**约定而非契约**，
 * description 是自由文本。所以解析必须能失败得干净：认不出就当 builtin。
 */
export type SlashCommandSource = 'builtin' | 'project' | 'user'

export interface SlashCommandInfo {
  /** 命令名，不含前导斜杠 */
  name: string
  /** 一行说明，已截断到适合弹层展示的长度 */
  description: string
  /** 参数提示（如 `[pr number]`），无参数时为空串 */
  argumentHint: string
  /** 别名，参与匹配但不单独成条 */
  aliases?: string[]
  source: SlashCommandSource
}

/** 分组展示顺序：内置命令最常用，用户 Skill 数量最多排最后。 */
export const SLASH_COMMAND_SOURCE_ORDER: SlashCommandSource[] = ['builtin', 'project', 'user']
