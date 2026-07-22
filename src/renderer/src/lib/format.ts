/** 时间格式化（相对时间） */
export function formatRelativeTime(ts: number): string {
  const now = Date.now()
  const diff = now - ts
  const sec = Math.floor(diff / 1000)
  const min = Math.floor(sec / 60)
  const hour = Math.floor(min / 60)
  const day = Math.floor(hour / 24)

  if (sec < 60) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  if (hour < 24) return `${hour} 小时前`
  if (day < 7) return `${day} 天前`
  // 超过一周用日期
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 字数/字符数格式化 */
export function formatCharCount(text: string): string {
  const n = text.length
  if (n < 1000) return `${n} chars`
  return `${(n / 1000).toFixed(1)}k chars`
}

/**
 * 消息时间格式化（hover 显示）。
 *
 * 三档最短化：
 *   - 当天：只显示 HH:MM（15:21）
 *   - 当年：显示 M/D HH:MM（7/13 15:21）
 *   - 跨年：显示 YYYY/M/D HH:MM（2026/1/13 15:21）
 */
export function formatMessageTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (sameDay) return `${hh}:${mm}`
  const sameYear = d.getFullYear() === now.getFullYear()
  if (sameYear) return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
}
