/**
 * Codex V4 Patch 解析器（shared 层，主进程 + 渲染器共用）。
 *
 * Codex 现代会话的 file change 用的是 V4 patch 格式（apply_patch 工具），不是标准 git
 * unified diff。`@git-diff-view` 期望 `@@ -a,b +c,d @@` 带行号的 hunk 头，V4 的裸 `@@`
 * 解析不了 → 渲染空白。这里把 V4 patch 解析成每个文件的 old/new 内容，喂给库的
 * `generateDiffFile`（它自己算行级 diff）。
 *
 * V4 patch 结构：
 * ```
 * *** Begin Patch
 * *** Add File: <path>        ← 整个文件新增，下面都是 + 行
 * +line1
 * +line2
 * *** Update File: <path>     ← 修改，按 @@ 分段
 * @@
 *  context line               ← 空格开头：上下文（old 和 new 都有）
 * -removed                    ← - 开头：删除（只在 old）
 * +added                      ← + 开头：新增（只在 new）
 * @@
 *  ...
 * *** Delete File: <path>     ← 整个文件删除
 *  line1                      ← 空格开头：原文（只在 old）
 * *** End Patch
 * ```
 *
 * 行前缀规则（实测 codex 下发）：
 * - `+`：新增行（Add File 下全是这种；Update File 里表示新增）
 * - `-`：删除行
 * - ` `（单个空格）：上下文行；**空行也编码成单个空格**（不是真·空字符串）
 * - Add File 里的「空行」是单独一个 `+`（去掉前缀后得到空字符串）
 */
import type { CodexFileChange } from './blocks/codex'

export type V4FileKind = 'add' | 'delete' | 'update'

export interface ParsedPatchFile {
  path: string
  kind: V4FileKind
  /** 修改前的完整内容（Add 文件为空串） */
  oldContent: string
  /** 修改后的完整内容（Delete 文件为空串） */
  newContent: string
}

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const ADD_PREFIX = '*** Add File: '
const DELETE_PREFIX = '*** Delete File: '
const UPDATE_PREFIX = '*** Update File: '

/**
 * 解析整段 V4 patch，返回每个文件的 old/new 内容。
 * 非 V4 格式（没有 *** Begin Patch）返回空数组，交给上层走标准 unified diff 逻辑。
 */
export function parseV4Patch(patch: string): ParsedPatchFile[] {
  const sections = splitV4PatchSections(patch)
  const result: ParsedPatchFile[] = []
  for (const s of sections) {
    if (s.kind === 'add') {
      const content = readAddedContent(s.bodyLines)
      result.push({ path: s.path, kind: 'add', oldContent: '', newContent: content })
    } else if (s.kind === 'delete') {
      const content = readDeletedContent(s.bodyLines)
      result.push({ path: s.path, kind: 'delete', oldContent: content, newContent: '' })
    } else {
      const { oldContent, newContent } = readUpdatedContent(s.bodyLines)
      result.push({ path: s.path, kind: 'update', oldContent, newContent })
    }
  }
  return result
}

/**
 * 从 V4 patch 里提取指定文件的 old/new 内容。
 * DiffView 渲染单文件时用——change.diff 可能是多文件整段 patch，这里按 path 切出那一段。
 * 找不到或非 V4 格式返回 null（交给上层走标准 unified diff / 纯文本 fallback）。
 */
export function extractFileFromV4Patch(
  patch: string,
  filePath: string,
): { oldContent: string; newContent: string } | null {
  const files = parseV4Patch(patch)
  const target = files.find((f) => samePath(f.path, filePath))
  if (!target) return null
  return { oldContent: target.oldContent, newContent: target.newContent }
}

/**
 * 解析**无文件头**的标准 unified diff（只有 `@@ ... @@` hunks，无 `---`/`+++`）成 old/new 内容。
 *
 * Codex 的 `patch_apply_end` 里每个文件的 `unified_diff` 就是这种格式：直接以
 * `@@ -a,b +c,d @@` 开头，没有 `--- a/path` / `+++ b/path` 文件头。
 * `@git-diff-view` 的 `new DiffFile(name,'',name,'',[diff])` 缺文件头时无法重建内容 →
 * 报 "oldFileContent and newFileContent are identical" → 渲染空白。
 *
 * 这里把 hunks 里的 `+`/`-`/` `（空格）行分别累积成 newContent/oldContent，
 * 再交给库的 generateDiffFile 让它重算行级 diff（输入有效就不会报错）。
 *
 * 注意：旧/新行号偏移在重算 diff 时会丢失（库按内容重新对齐），但对审查展示无影响。
 *
 * 输入是标准 unified diff（含 `@@` hunk 头）时返回 old/new；否则返回 null（交给上层）。
 */
export function parseUnifiedDiffHunks(
  diff: string,
): { oldContent: string; newContent: string } | null {
  // 必须含 hunk 头才算 unified diff
  if (!/^@@ /m.test(diff)) return null
  const oldLines: string[] = []
  const newLines: string[] = []
  let inHunk = false
  for (const line of diff.split('\n')) {
    // hunk 头：@@ -a,b +c,d @@ ... —— 跳过
    if (/^@@ /.test(line)) {
      inHunk = true
      continue
    }
    if (!inHunk) {
      // hunk 头之前的内容（--- / +++ 文件头、diff --git 等）忽略
      continue
    }
    if (line.startsWith('\\')) {
      // "\ No newline at end of file" 标记，跳过
      continue
    }
    if (line.startsWith('+')) {
      newLines.push(line.slice(1))
    } else if (line.startsWith('-')) {
      oldLines.push(line.slice(1))
    } else if (line.startsWith(' ')) {
      // 上下文行
      oldLines.push(line.slice(1))
      newLines.push(line.slice(1))
    } else if (line === '') {
      // 空行：unified diff 里空行应是 ' '（单空格），但有些来源给真·空串，按上下文兜底
      oldLines.push('')
      newLines.push('')
    }
  }
  if (oldLines.length === 0 && newLines.length === 0) return null
  return { oldContent: oldLines.join('\n'), newContent: newLines.join('\n') }
}

/**
 * 把整段 V4 patch input 转成 `CodexFileChange[]`，每文件的 `diff` 填**该文件对应的 V4 子段**。
 *
 * mapping 层把 `custom_tool_call(name=apply_patch).input` 转成 file_change 活动时用：
 * - 每个 `*** Add/Update/Delete File` 段单独成一个 CodexFileChange
 * - `diff` 是该段原文（含 `*** xxx File:` 头 + 行），这样渲染器 `extractFileFromV4Patch`
 *   能从单个文件的 diff 里再切出 old/new（每文件 diff 干净、stats 准确）
 * - `stats` 按 V4 行前缀算 +/-（diffStats 复用）
 *
 * 非 V4 格式返回空数组。
 */
export function v4PatchToCodexFileChanges(input: string): CodexFileChange[] {
  const sections = splitV4PatchSections(input)
  return sections.map((s) => {
    // 重建该文件的 V4 子段：头行 + body 行（不含 Begin/End）
    const diffLines = [s.headerLine, ...s.bodyLines]
    const diff = diffLines.join('\n')
    const { additions, deletions } = countV4Stats(s)
    const kind: CodexFileChange['kind'] =
      s.kind === 'add' ? 'add' : s.kind === 'delete' ? 'delete' : 'update'
    return { path: s.path, kind, diff, stats: { additions, deletions } }
  })
}

// ===== 内部：V4 patch 分段 =====

interface V4Section {
  path: string
  kind: V4FileKind
  /** 段头原文，如 `*** Update File: src/foo.ts` */
  headerLine: string
  /** 段体行（不含头、不含下一段头、不含 Begin/End） */
  bodyLines: string[]
}

/**
 * 把整段 V4 patch 按文件切成段。非 V4 格式返回空数组。
 * 这是 parseV4Patch / v4PatchToCodexFileChanges / extractFileFromV4Patch 的公共前置。
 */
function splitV4PatchSections(patch: string): V4Section[] {
  if (!patch.includes(BEGIN)) return []
  const lines = patch.split('\n')
  const sections: V4Section[] = []
  let i = 0
  // 跳到 *** Begin Patch
  while (i < lines.length && lines[i] !== BEGIN) i++
  i++

  while (i < lines.length) {
    const line = lines[i]!
    if (line === END || line === BEGIN) break

    let kind: V4FileKind | null = null
    let prefix = ''
    if (line.startsWith(ADD_PREFIX)) {
      kind = 'add'
      prefix = ADD_PREFIX
    } else if (line.startsWith(DELETE_PREFIX)) {
      kind = 'delete'
      prefix = DELETE_PREFIX
    } else if (line.startsWith(UPDATE_PREFIX)) {
      kind = 'update'
      prefix = UPDATE_PREFIX
    }

    if (kind) {
      const path = line.slice(prefix.length).trim()
      i++
      const start = i
      while (i < lines.length && !isSectionHeader(lines[i]!)) i++
      sections.push({
        path,
        kind,
        headerLine: line,
        bodyLines: lines.slice(start, i),
      })
    } else {
      // 未知行（理论上不会出现），跳过避免死循环
      i++
    }
  }
  return sections
}

// ===== 内部：各类文件的行 → 内容 =====

/** Add File 的行：全是 `+` 开头（含单独 `+` 表示空行） */
function readAddedContent(bodyLines: string[]): string {
  const out: string[] = []
  for (const line of bodyLines) {
    if (line.startsWith('+')) out.push(line.slice(1))
    // Add File 里理论上不该出现非 + 行，兜底跳过
  }
  return out.join('\n')
}

/** Delete File 的行：空格开头（上下文/原文）；空行也当原文 */
function readDeletedContent(bodyLines: string[]): string {
  return bodyLines.map((line) => (line.startsWith(' ') ? line.slice(1) : line)).join('\n')
}

/**
 * Update File 的行：按 `@@` 分段，段内 `+`/`-`/` `（空格）混合。
 * 把所有段按出现顺序拼成完整 old（context + 删除）和 new（context + 新增）。
 */
function readUpdatedContent(bodyLines: string[]): { oldContent: string; newContent: string } {
  const oldLines: string[] = []
  const newLines: string[] = []
  for (const line of bodyLines) {
    if (line === '@@') continue // hunk 分隔符，不产生内容行
    if (line.startsWith('+')) {
      newLines.push(line.slice(1))
    } else if (line.startsWith('-')) {
      oldLines.push(line.slice(1))
    } else {
      // 空格开头 = 上下文，old 和 new 都有；真·空行也按上下文处理
      const content = line.startsWith(' ') ? line.slice(1) : line
      oldLines.push(content)
      newLines.push(content)
    }
  }
  return { oldContent: oldLines.join('\n'), newContent: newLines.join('\n') }
}

/** 按 V4 行前缀算单文件的 +/- 数（与 mapping 的 diffStats 语义一致） */
function countV4Stats(section: V4Section): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of section.bodyLines) {
    // 头行（*** xxx File:）不以 +/- 开头，@@ 也不，自然不计入
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}

/** `*** xxx` 段头或 End/Begin 标记——读到这些要停 */
function isSectionHeader(line: string): boolean {
  return line.startsWith('*** ') || line === END
}

/** 路径归一化比较：codex 下发的可能是绝对路径，UI 里可能是相对路径，按末尾段对齐 */
function samePath(a: string, b: string): boolean {
  if (a === b) return true
  const na = normalizePath(a)
  const nb = normalizePath(b)
  return na === nb || na.endsWith(nb) || nb.endsWith(na)
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}
