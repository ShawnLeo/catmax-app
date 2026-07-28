/**
 * 中断 sentinel 文本识别——纯函数，main + renderer 共用同一判断（cross-layer）。
 *
 * Claude Code / Claude SDK 在用户中断一个回合后，会把形如
 *   `[Request interrupted by user]`
 *   `[Request interrupted by user for tool use]`
 * 的 sentinel 写入 transcript JSONL（`~/.claude/projects/.../*.jsonl`），
 * 作为回合边界标记。catmax 实时路径用 `turn_completed(status:'interrupted')`
 * 表示中断，从不插入这种文本；只有历史回放会读到它。
 *
 * 历史回放识别到命中后，仍构造一条 `role:'user'` 消息、`textBlocks[0].text`
 * 保留原始 sentinel 原文，让 renderer（MessageItem.vue）在 `<article>` 外层
 * 拦截并用 `InterruptedHistoryEntry.vue` 特殊样式渲染——绕过 user 气泡布局。
 * 复刻 `/compact` 的拦截渲染模式。
 */

export interface InterruptMarker {
  /**
   * 'user' = `[Request interrupted by user]`（用户停止整个回合）
   * 'tool' = `[Request interrupted by user for tool use]`（用户在工具调用时停止）
   */
  variant: 'user' | 'tool'
}

/**
 * 已知的中断 sentinel 文本。
 *
 * - 整句匹配（首尾 `[]`），前后容忍空白；
 * - 不匹配嵌入在更长文本里的同名子串（避免误伤用户真的输入这句话）。
 */
const INTERRUPT_MARKER_RE = /^\[Request interrupted by user( for tool use)?\]$/

/** 识别 user 文本是否是 Claude 写入的中断 sentinel；命中返回变体，否则 null。 */
export function matchInterruptMarker(text: string): InterruptMarker | null {
  const m = text.trim().match(INTERRUPT_MARKER_RE)
  if (!m) return null
  return { variant: m[1] ? 'tool' : 'user' }
}
