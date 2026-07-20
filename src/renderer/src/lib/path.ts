/**
 * 文件路径处理工具——给 ToolCallCard / ToolCallInline / FilePill 共用。
 *
 * 设计原则：UI 上只展示文件名（basename），完整路径作为 hover tooltip 保留——
 * 完整路径在窄对话区里 truncate 会把文件名截没，而文件名才是用户识别的关键。
 */

/**
 * 取路径的 basename（最后一段）。
 *
 * `/Users/shawn/foo/bar.ts` → `bar.ts`
 * `bar.ts` → `bar.ts`（已经是 basename）
 * `''` → `''`
 *
 * 不引 node:path——renderer 环境不一定有，且逻辑简单。
 */
export function basename(filePath: string): string {
  if (!filePath) return ''
  // 同时处理 / 和 \（兼容 Windows 路径）
  const normalized = filePath.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/**
 * 取目录部分（dirname）——给 hover tooltip 用。
 *
 * `/Users/shawn/foo/bar.ts` → `/Users/shawn/foo`
 * `bar.ts` → `''`
 */
export function dirname(filePath: string): string {
  if (!filePath) return ''
  const normalized = filePath.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(0, idx) : ''
}
