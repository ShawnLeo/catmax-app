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
