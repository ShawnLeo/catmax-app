/**
 * File Mention: 输入框里的 `@路径` token —— 解析、格式化、增删的纯函数。
 *
 * 这一层是整个文件引用功能的真相来源。输入框文本是唯一状态，Composer 上方的
 * 引用 pill 完全由 parseFileMentions(text) 派生：用户手删文本里的 token，pill
 * 跟着消失；点 pill 的 ✕ 就是从文本里删掉那一段。两份表示不可能对不上，也就
 * 不需要任何同步逻辑。
 *
 * 代价是 token 只能承载路径本身——带正文的引用（ide_selection 的代码片段）
 * 表达不出来，那类仍走 chat-input store 的 pendingAttachments。
 */

export interface FileMention {
  /** 引用的路径（已去掉包裹引号），工作区内为相对路径，区外为 `~/…` 或绝对路径 */
  path: string
  /** token 在原文本中的起始偏移（指向 `@`） */
  start: number
  /** token 在原文本中的结束偏移（开区间） */
  end: number
}

/**
 * `@` 必须在行首或空白之后——否则 `foo@bar.com`、`user@host:~/x` 这类会被
 * 当成引用。捕获组二选一：带引号的（允许空格，macOS 上 `~/Desktop/My File.txt`
 * 很常见）和不带引号的（到下一个空白为止）。
 *
 * 前导的 `(?:^|\s)` 不能用 lookbehind——Electron 31 的 Chromium 支持，但 Safari
 * 之外的构建目标没必要冒这个险，改成捕获后手动加偏移。
 */
const MENTION_RE = /(^|\s)@(?:"([^"\n]+)"|([^\s"]+))/g

/** 扫出文本里全部 `@路径` token，按出现顺序返回。 */
export function parseFileMentions(text: string): FileMention[] {
  const out: FileMention[] = []
  MENTION_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MENTION_RE.exec(text)) !== null) {
    const lead = m[1] ?? ''
    const path = m[2] ?? m[3] ?? ''
    if (!path) continue
    const start = m.index + lead.length
    out.push({ path, start, end: start + (m[0].length - lead.length) })
  }
  return out
}

/** 路径 → token 文本。含空格或引号的路径必须加引号，否则回读时会被空白截断。 */
export function formatFileMention(path: string): string {
  return /[\s"]/.test(path) ? `@"${path}"` : `@${path}`
}

/** 文本里已经引用过这个路径了吗（用于拖同一个文件两次时跳过）。 */
export function hasFileMention(text: string, path: string): boolean {
  return parseFileMentions(text).some((m) => m.path === path)
}

/**
 * 追加一条引用到文本末尾，返回新文本。
 *
 * 统一插到末尾而不是光标处：拖拽和右键这两个入口触发时输入框通常没有焦点，
 * 光标位置要么不存在要么是上一次遗留的，插在那里比插末尾更让人意外。
 *
 * 已经引用过则原样返回——重复拖同一个文件基本都是误操作。
 */
export function appendFileMention(text: string, path: string): string {
  if (hasFileMention(text, path)) return text
  const token = formatFileMention(path)
  if (text.length === 0) return `${token} `
  return /\s$/.test(text) ? `${text}${token} ` : `${text} ${token} `
}

/**
 * 删掉指定位置的 token，返回新文本。
 *
 * 一并吞掉 token 后面紧跟的一个空格——那个空格是 appendFileMention 自己加的，
 * 留着会在文本里攒出一串孤立空格。
 */
export function removeFileMentionAt(text: string, mention: FileMention): string {
  let end = mention.end
  if (text[end] === ' ') end += 1
  return text.slice(0, mention.start) + text.slice(end)
}

/**
 * 把文本切成「普通片段」和「引用片段」的序列——给高亮覆盖层渲染用。
 * 覆盖层必须逐字符复刻原文本（含空白），所以这里返回的片段拼起来必须等于 text。
 */
export interface MentionSegment {
  text: string
  mention: FileMention | null
}

export function segmentFileMentions(text: string): MentionSegment[] {
  const mentions = parseFileMentions(text)
  if (mentions.length === 0) return [{ text, mention: null }]
  const out: MentionSegment[] = []
  let cursor = 0
  for (const m of mentions) {
    if (m.start > cursor) out.push({ text: text.slice(cursor, m.start), mention: null })
    out.push({ text: text.slice(m.start, m.end), mention: m })
    cursor = m.end
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), mention: null })
  return out
}
