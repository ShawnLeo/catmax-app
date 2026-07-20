/**
 * Context tag 提取 / 序列化纯函数——前后端共用。
 *
 * 不依赖 Vue，不依赖任何 side effect。所有 handler 的 extract 函数都是纯函数。
 */
import type { ContextBlock, ContextTagExtractor, ContextTagMatch } from './context-tag-types'

/**
 * 把 user 文本扫一遍，按所有 handler 提取 context tag。
 *
 * 算法：
 * 1. 每个 handler 各自 extract(text) 拿到自己的 matches
 * 2. 全部合并，按 start 位置排序
 * 3. 去重叠（两个 handler 匹配了同一段文本，先注册的优先）
 * 4. 按 removeFromText 决定是否从原文中切除，切出来的 tag 段落汇聚成 contextBlocks
 * 5. 剩余的纯文本作为返回值的 text 字段
 *
 * 文本片段之间的空行清理：如果 tag 被切走后留下连续 3+ 个换行，压缩成 2 个。
 *
 * @param text 原始 user 文本
 * @param extractors 已注册的 handler 列表（main 端用 sharedHandlers，renderer 端用 registry.all()）
 * @returns { text: 去掉被提取内容后的纯文本, blocks: 按出现顺序的 contextBlocks }
 */
export function extractContextTags(
  text: string,
  extractors: ContextTagExtractor[],
): { text: string; blocks: ContextBlock[] } {
  // 1. 收集所有 handler 的 matches
  const allMatches: Array<ContextTagMatch & { tag: string; removeFromText: boolean }> = []
  for (const ext of extractors) {
    const removeFromText = ext.removeFromText !== false // 默认 true
    const matches = ext.extract(text)
    for (const m of matches) {
      allMatches.push({ ...m, tag: ext.tag, removeFromText })
    }
  }

  if (allMatches.length === 0) {
    return { text, blocks: [] }
  }

  // 2. 按 start 排序，重叠的保留 start 更小的（先注册优先——stable sort）
  allMatches.sort((a, b) => a.start - b.start)

  // 3. 去重叠：丢弃被前一个 match 完全包含或相交的
  const kept: typeof allMatches = []
  let lastEnd = -1
  for (const m of allMatches) {
    if (m.start >= lastEnd) {
      kept.push(m)
      lastEnd = m.end
    }
    // 否则丢弃（重叠了）
  }

  // 4. 切片：被 kept 覆盖的区段切出来形成 block，剩下的拼成新 text
  let newText = ''
  let cursor = 0
  const blocks: ContextBlock[] = []
  for (const m of kept) {
    // cursor → m.start 之间的文本保留
    newText += text.slice(cursor, m.start)
    // m.start → m.end 是 tag 内容
    blocks.push({ tag: m.tag, data: m.data })
    cursor = m.end
  }
  newText += text.slice(cursor)

  // 5. 清理：去掉因切除 tag 留下的多余空行（3+ 换行 → 2 换行）
  newText = newText.replace(/\n{3,}/g, '\n\n')

  // 6. trim 首尾（tag 在文本头尾时会留下空白）
  newText = newText.replace(/^\n+/, '').replace(/\n+$/, '')

  return { text: newText, blocks }
}

/**
 * 反向：把 user prompt 文本 + contextBlocks 序列化成给后端的完整 prompt 字符串。
 *
 * 实时发送时用——Composer 收集的 attachments 转 contextBlocks 后，
 * 调本函数拼成带 sentinel 的完整 prompt，发给后端 adapter（claude/codex 都收字符串）。
 *
 * 约定：contextBlocks 拼接到 prompt 文本**之后**，每个 block 之间空行分隔。
 * 这样 agent 读到的 prompt 结构是：用户输入 → 后跟若干 context tag。
 *
 * @param prompt 用户输入的纯文本
 * @param blocks attachments 转换来的 contextBlocks
 * @returns 拼接后的完整 prompt 字符串
 */
export function serializeContextTags(prompt: string, blocks: ContextBlock[]): string {
  if (blocks.length === 0) return prompt

  // 委托给每个 tag 的 encode 逻辑——但 serialize 在 shared 层不能依赖具体 handler
  // 所以这里用一个内置的 encode 映射，按 tag 名分发
  const parts = [prompt]
  for (const block of blocks) {
    const encoded = encodeContextBlock(block)
    if (encoded) parts.push(encoded)
  }
  return parts.filter(Boolean).join('\n\n')
}

/**
 * 把单个 ContextBlock 编码回 XML sentinel 文本。
 *
 * 新增 tag 时需要在 TAG_ENCODERS 注册 encode 函数。
 * 跟 handler 的 extract 是互逆关系——
 *   extract: text → data
 *   encode: data → text
 *
 * 这里只覆盖 catmax 自己发送的 tag（ide_selection 之类）；
 * 历史回放识别的 environment_context 不需要 encode（catmax 不会主动发它）。
 */
const TAG_ENCODERS: Record<string, (data: unknown) => string | null> = {
  ide_selection: (data) => {
    const d = data as { filePath: string; startLine: number; endLine: number; code: string }
    const lineCount = d.endLine - d.startLine + 1
    const linesWord = lineCount === 1 ? 'line' : 'lines'
    return [
      `<ide_selection>The user selected the ${linesWord} ${d.startLine} to ${d.endLine} from ${d.filePath}:`,
      d.code,
      'This may or may not be related to the current task.</ide_selection>',
    ].join('\n')
  },
  ide_opened_file: (data) => {
    const d = data as { filePath: string }
    return `<ide_opened_file>The user opened the file ${d.filePath} in the IDE. This may or may not be related to the current task.</ide_opened_file>`
  },
}

function encodeContextBlock(block: ContextBlock): string | null {
  const encoder = TAG_ENCODERS[block.tag]
  if (!encoder) return null // 未知 tag 不编码（agent 不会收到，但不影响其他 block）
  try {
    return encoder(block.data)
  } catch {
    return null
  }
}
