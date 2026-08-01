/**
 * 改动行数统计（+N / -M）。
 *
 * 两个来源，各自的精度不同，调用方要清楚拿到的是哪一种：
 *
 * - `countUnifiedDiffStats`：数 diff 文本里的 +/- 行。这是**精确**的——diff 本身
 *   就是逐行结论，我们只是数一遍。codex 的 file_change.diff 走这条。
 * - `countLineDiffStats`：拿 old/new 两段文本现算行级 diff。claude 的 Edit/MultiEdit
 *   只给替换前后的字符串，没有 diff，只能自己算。
 *
 * 两条路都不涉及磁盘上的真实文件——统计的是"这次工具调用声明的改动"，不是
 * "文件最终变成什么样"。同一行被后续调用再改一次，这里会各记各的。
 */

import type { ToolEditInfo } from '@shared/backend/types'

export interface DiffStats {
  additions: number
  deletions: number
}

/**
 * LCS 动态规划的格子数上限。
 *
 * 超过就退回"整段算全改"（见 countLineDiffStats）。10^6 个格子按 Int32Array 两行滚动
 * 只占几 KB 内存，耗时在毫秒级；真正的风险是把主线程堵住，而单次 Edit 的替换段落
 * 超过千行本身就极罕见，退化路径的误差远比卡顿可接受。
 */
const LCS_CELL_LIMIT = 1_000_000

/**
 * 数 unified diff（或 codex V4 patch）文本里的 +/- 行。
 *
 * `+++`/`---` 是文件头不是内容行，必须排除；V4 patch 的 `*** Update File:` 一类
 * 标记行不以 +/- 开头，自然落不到统计里。
 */
export function countUnifiedDiffStats(diff: string): DiffStats {
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++
    if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  return { additions, deletions }
}

/**
 * 现算两段文本的行级增删。
 *
 * 先掐掉公共首尾（绝大多数编辑只动中间一小段，这一步就能把 DP 规模砍到个位数行），
 * 再对剩下的部分做 LCS——中间夹着未改动行的多处替换必须靠 LCS 才不会被整段算成
 * 全改。掐首尾之后仍然过大时退回"剩余行全算改动"，宁可高估也不阻塞渲染。
 */
export function countLineDiffStats(oldText: string, newText: string): DiffStats {
  if (oldText === newText) return { additions: 0, deletions: 0 }

  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)

  // 公共前缀
  let start = 0
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start++
  }
  // 公共后缀（不与前缀重叠）
  let endOld = oldLines.length
  let endNew = newLines.length
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--
    endNew--
  }

  const oldRest = oldLines.slice(start, endOld)
  const newRest = newLines.slice(start, endNew)
  if (oldRest.length === 0 || newRest.length === 0) {
    // 纯新增或纯删除，不需要 LCS
    return { additions: newRest.length, deletions: oldRest.length }
  }
  if (oldRest.length * newRest.length > LCS_CELL_LIMIT) {
    return { additions: newRest.length, deletions: oldRest.length }
  }

  const common = lcsLength(oldRest, newRest)
  return { additions: newRest.length - common, deletions: oldRest.length - common }
}

/**
 * 把一次工具调用的编辑数据折算成 +N / -M。
 *
 * MultiEdit 会把每一组替换分别统计后累加——那才是这次调用对文件的总改动量。
 * 注意 DiffView 目前只渲染第一组，所以展开后看到的 diff 可能比这里的数字少。
 *
 * 返回 null 表示"这次调用算不出行数"（数据残缺，或 Write 了个空文件），
 * 调用方据此不显示徽标，而不是显示一个骗人的 +0 -0。
 */
export function editDiffStats(edit: ToolEditInfo): DiffStats | null {
  switch (edit.type) {
    case 'unified_diff': {
      if (!edit.diff) return null
      return countUnifiedDiffStats(edit.diff)
    }
    case 'full_content': {
      // 整文件覆盖：拿不到旧内容（claude 的 Write 入参里没有），只能算新增。
      // DiffView 也是同样的处理——整块标绿，两边口径一致。
      if (!edit.content) return null
      return { additions: splitLines(edit.content).length, deletions: 0 }
    }
    case 'string_replace': {
      const groups = edit.edits?.length
        ? edit.edits
        : [{ oldString: edit.oldString ?? '', newString: edit.newString ?? '' }]
      let additions = 0
      let deletions = 0
      for (const group of groups) {
        const stats = countLineDiffStats(group.oldString, group.newString)
        additions += stats.additions
        deletions += stats.deletions
      }
      return { additions, deletions }
    }
    default:
      return null
  }
}

/**
 * 按行切分。
 *
 * 结尾换行是行终止符不是空行——`"a\n"` 是一行而不是两行，不丢掉的话每个文件都会
 * 凭空多出一行新增。`\r\n` 一并归一，否则 CRLF 文件的每一行都会因为末尾的 `\r`
 * 判成不相等，整段被算作全改。
 */
function splitLines(text: string): string[] {
  if (!text) return []
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** 标准 LCS 长度 DP，滚动两行，只求长度不回溯路径。 */
function lcsLength(a: string[], b: string[]): number {
  let prev = new Int32Array(b.length + 1)
  let curr = new Int32Array(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!)
    }
    const swap = prev
    prev = curr
    curr = swap
    curr.fill(0)
  }
  return prev[b.length]!
}
