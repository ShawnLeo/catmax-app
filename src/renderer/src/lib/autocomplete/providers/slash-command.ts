/**
 * Composer Autocomplete: 斜杠命令联想。
 *
 * 这一层是后端无关的：命令名和说明全部来自 commands/ 下按后端分的表，这里只负责
 * 「什么时候算触发 → 怎么匹配 → 插成什么文本」。
 *
 * 跟文件联想的两个明显差异，都是命令的性质决定的：
 *   - 触发要求在整段文本最开头（`atTextStart`）。`/compact` 只有作为整条消息才是
 *     命令，句中的 `and/or`、`每秒 3/4 帧` 都不该弹。
 *   - 是本地静态表的过滤，不发 IPC，所以不需要担心慢查询——防抖那层照样管着。
 */
import { SquareSlashIcon } from 'lucide-vue-next'

import { slashCommandsFor, type SlashCommandSpec } from '../commands'
import { charTrigger } from '../trigger'
import type { SuggestionItem, SuggestionProvider, TriggerMatch } from '../types'

const detectSlash = charTrigger({ char: '/', atTextStart: true })

export const slashCommandProvider: SuggestionProvider = {
  id: 'slash-command',
  emptyText: '没有匹配的命令',

  /*
   * 当前后端一条命令都没有时（codex 就是），`/` 干脆不算触发字符。
   *
   * 让它在检测阶段就返回 null，而不是弹出来再显示「没有匹配的命令」：后者会让
   * codex 用户每写一条以 `/` 开头的消息都闪一下空列表，而那个列表永远不可能有
   * 内容——不是「没搜到」，是这个后端就没有这个概念。
   */
  detect(text, caret, ctx) {
    if (slashCommandsFor(ctx.backendId).length === 0) return null
    return detectSlash(text, caret)
  },

  async search(match, ctx) {
    const query = match.query.toLowerCase()
    return slashCommandsFor(ctx.backendId)
      .filter((spec) => matches(spec, query))
      .map((spec) => toItem(spec, match))
  },
}

/** 命令名或别名的前缀匹配——命令名很短，子串匹配只会带来噪音。 */
function matches(spec: SlashCommandSpec, query: string): boolean {
  if (query === '') return true
  if (spec.name.toLowerCase().startsWith(query)) return true
  return (spec.aliases ?? []).some((alias) => alias.toLowerCase().startsWith(query))
}

function toItem(spec: SlashCommandSpec, match: TriggerMatch): SuggestionItem {
  /*
   * 带参数的命令补一个尾随空格，让用户接着打参数；不带参数的不补——那条消息
   * 已经完整了，直接回车就该发出去，多一个空格是噪音。
   *
   * 不补空格意味着插入后光标仍落在一个合法触发段里（`/context` 的 `/` 还在开头），
   * 弹层会想再弹回来；useAutocomplete.applyAt 统一挡掉了这种「刚插完又弹」。
   */
  const insert = `${match.char}${spec.name}${spec.argumentHint ? ' ' : ''}`
  return {
    id: spec.name,
    // 参数提示跟在命令名后面（而不是塞进 detail）：它是「这条命令怎么用」的一
    // 部分，读起来就该是 `/compact [保留重点]`；detail 那一栏窄屏会被截掉。
    label: spec.argumentHint
      ? `${match.char}${spec.name} ${spec.argumentHint}`
      : `${match.char}${spec.name}`,
    detail: spec.description,
    icon: { kind: 'lucide', component: spec.icon ?? SquareSlashIcon },
    insert,
  }
}
