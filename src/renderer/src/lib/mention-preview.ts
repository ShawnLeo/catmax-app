/**
 * File Mention: 引用 pill 的元数据（是否目录 + 图片缩略图）取用入口，带模块级缓存。
 *
 * 缓存不是优化，是必需的：pill 列表由输入框文本派生，用户每敲一个字符整份
 * 列表就重算一次。没有缓存的话，打一句话就够触发几十次跨进程解析 + 解码。
 *
 * 缓存的是 Promise 而不是结果——同一路径的并发请求要合流到一次 IPC，
 * 否则一次性拖进五张同名图仍然会发五次。
 *
 * 失败（解析不到 / 不是图片 / 太大）同样缓存 null：那也是个稳定答案，
 * 不该每次重挂载都再问一遍主进程。
 */
import type { MentionPreview } from '@shared/ipc/fs'

/** key = `${workspaceId} ${reference}` —— 换工作区后同一条相对路径指向的是别的文件。 */
const cache = new Map<string, Promise<MentionPreview | null>>()

/**
 * 缓存上限。引用是短生命周期的（发出去就没了），但一次会话里可能拖过很多图，
 * 不封顶等于内存只增不减。超了就整份丢掉重来——LRU 对这个量级不值得。
 */
const MAX_ENTRIES = 200

export function readMentionPreview(
  workspaceId: string,
  reference: string,
): Promise<MentionPreview | null> {
  const key = `${workspaceId} ${reference}`
  const cached = cache.get(key)
  if (cached) return cached

  const request = (async () => {
    const read = window.api.fs.readMentionPreview
    // 开发时 renderer 已热更新而 main 还是旧进程——没有这个方法就当拿不到元数据，
    // 退回普通文件图标，不要让 pill 整个炸掉。
    if (typeof read !== 'function') return null
    try {
      return await read({ workspaceId, reference })
    } catch {
      return null
    }
  })()

  if (cache.size >= MAX_ENTRIES) cache.clear()
  cache.set(key, request)
  return request
}
