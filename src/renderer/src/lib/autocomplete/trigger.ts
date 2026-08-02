/**
 * Composer Autocomplete: 触发段检测。
 *
 * 纯字符串逻辑，不碰 DOM 也不碰 Vue——联想里最容易出错的部分（`foo@bar.com`
 * 不该弹、跨行不该连起来、光标退到触发字符前面要关掉）全在这里，也全都能单测。
 */
import type { TriggerDetector, TriggerMatch } from './types'

export interface CharTriggerOptions {
  /** 触发字符，单个字符（`@`、`/`） */
  char: string
  /**
   * 触发字符前面必须是行首或空白。
   *
   * `@` 必须开：不然 `foo@bar.com`、`user@host:/tmp` 打到一半就会弹出文件列表。
   * 这条跟 file-mention.ts 里 MENTION_RE 的 `(^|\s)` 是同一条规则——两边不一致
   * 会出现「联想能弹出来，插进去却不被识别成引用」。
   */
  requireBoundary?: boolean
  /**
   * 触发字符必须在整段文本的最开头。
   *
   * 给斜杠命令准备的：`/compact` 只有作为整条消息才是命令，句中的 `and/or`
   * 不该弹命令列表。`@` 不开这条（句中引用文件是常态）。
   */
  atTextStart?: boolean
  /**
   * query 里允许出现空格。
   *
   * 默认关，代价是带空格的路径（`~/My Documents/a.txt`）联想不出来——那类靠
   * 拖放和「+」按钮进来。打开它的话，用户打完 `@` 之后写的每一句话都会一直
   * 被当成查询词，弹层永远关不掉，这个代价大得多。
   */
  allowSpace?: boolean
  /**
   * query 的长度上限，超过就当作没在触发段里。
   *
   * 兜底而非优化：用户打了 `@` 之后改主意继续写正文（且正文没空格，比如中文），
   * 没有上限的话弹层会挂着不放，每敲一个字还发一次搜索。
   */
  maxQueryLength?: number
}

const DEFAULT_MAX_QUERY_LENGTH = 80

/**
 * 造一个「从光标往前找最近的触发字符」的检测器。
 *
 * 往前扫而不是用正则整体匹配：正则要么匹配到光标之后的内容（用户在句中插入时
 * 就错了），要么得为每种触发规则各写一条难读的正则。往前扫是 O(query 长度)，
 * 每次按键跑一遍毫无压力。
 */
export function charTrigger(options: CharTriggerOptions): TriggerDetector {
  const {
    char,
    requireBoundary = true,
    atTextStart = false,
    allowSpace = false,
    maxQueryLength = DEFAULT_MAX_QUERY_LENGTH,
  } = options

  return (text: string, caret: number): TriggerMatch | null => {
    if (caret < 0 || caret > text.length) return null
    const lowerBound = Math.max(0, caret - maxQueryLength - 1)

    for (let i = caret - 1; i >= lowerBound; i--) {
      const ch = text[i]!
      // 换行永远终止：触发段不跨行，否则上一行的 `@` 会一直粘着下一行。
      if (ch === '\n') return null
      if (!allowSpace && /\s/.test(ch)) return null
      if (ch !== char) continue

      if (atTextStart && i !== 0) return null
      if (requireBoundary && i > 0 && !/\s/.test(text[i - 1]!)) return null
      return { char, start: i, end: caret, query: text.slice(i + 1, caret) }
    }
    return null
  }
}
