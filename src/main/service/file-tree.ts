/**
 * 文件浏览服务。
 *
 * 所有 renderer 提供的路径都必须先经过工作区边界校验。目录按需读取，
 * 搜索使用有上限的广度遍历，预览只读取需要的字节，避免大文件占满内存。
 */
import { promises as fs, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { DirEntry, FilePreview, FilePreviewKind, ResolvedFileReference } from '@shared/ipc/fs'
import ignore, { type Ignore } from 'ignore'

import { logger } from './logger'

const log = logger.domain('file-tree')

const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  'dist',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  '.DS_Store',
  'Thumbs.db',
  '*.log',
]

const MAX_DIRECTORY_ENTRIES = 2000
const MAX_SEARCH_VISITS = 20_000
const MAX_SEARCH_RESULTS = 200
const MAX_TEXT_PREVIEW_BYTES = 512 * 1024
const MAX_MEDIA_PREVIEW_BYTES = 12 * 1024 * 1024

const IMAGE_MIME: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
}

const AUDIO_MIME: Record<string, string> = {
  aac: 'audio/aac',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
}

const VIDEO_MIME: Record<string, string> = {
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  ogv: 'video/ogg',
  webm: 'video/webm',
}

const DOCUMENT_MIME: Record<string, string> = {
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odp: 'application/vnd.oasis.opendocument.presentation',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odt: 'application/vnd.oasis.opendocument.text',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

const ARCHIVE_MIME: Record<string, string> = {
  '7z': 'application/x-7z-compressed',
  bz2: 'application/x-bzip2',
  gz: 'application/gzip',
  rar: 'application/vnd.rar',
  tar: 'application/x-tar',
  tgz: 'application/gzip',
  zip: 'application/zip',
}

const TABLE_EXTENSIONS = new Set(['csv', 'psv', 'tsv'])
const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx', 'markdown'])

/**
 * File Tree Security:
 * 解析路径并确保最终真实路径仍在工作区内。
 * realpath 校验同时阻止 `..` 穿越和指向工作区外的符号链接。
 */
export async function resolveWorkspaceEntry(
  workspacePath: string,
  inputPath: string,
): Promise<{ absolutePath: string; relativePath: string }> {
  const root = await fs.realpath(workspacePath)
  const candidate = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath || '.')
  assertWithinRoot(root, candidate)

  const realTarget = await fs.realpath(candidate)
  assertWithinRoot(root, realTarget)

  return {
    absolutePath: realTarget,
    relativePath: toPosixPath(relative(root, candidate)),
  }
}

export async function readDirectory(
  workspacePath: string,
  relativePath = '',
  respectGitignore = true,
): Promise<DirEntry[]> {
  const { absolutePath, relativePath: safeRelativePath } = await resolveWorkspaceEntry(
    workspacePath,
    relativePath,
  )
  const stat = await fs.stat(absolutePath)
  if (!stat.isDirectory()) throw new Error(`not a directory: ${relativePath}`)

  const ig = respectGitignore ? await loadGitignore(workspacePath) : ignore().add(DEFAULT_IGNORE)
  const entries = await fs.readdir(absolutePath, { withFileTypes: true })
  const visible = entries
    .filter((entry) => !DEFAULT_IGNORE.includes(entry.name))
    .slice(0, MAX_DIRECTORY_ENTRIES)

  if (entries.length > MAX_DIRECTORY_ENTRIES) {
    log.warn('hit MAX_DIRECTORY_ENTRIES, truncating:', absolutePath)
  }

  const result = await Promise.all(
    visible.map((entry) =>
      toDirectoryEntry(absolutePath, safeRelativePath, entry, ig).catch((error: unknown) => {
        log.debug('skip unreadable directory entry:', entry.name, error)
        return null
      }),
    ),
  )

  return result.filter((entry): entry is DirEntry => entry !== null).sort(compareDirectoryEntries)
}

/**
 * File Tree Search:
 * 有上限地遍历工作区，并同时应用默认忽略项和项目 `.gitignore`。
 */
export async function searchWorkspace(
  workspacePath: string,
  query: string,
  requestedLimit = MAX_SEARCH_RESULTS,
): Promise<DirEntry[]> {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return []

  const root = await fs.realpath(workspacePath)
  const ig = await loadGitignore(root)
  const limit = Math.max(1, Math.min(requestedLimit, MAX_SEARCH_RESULTS))
  const queue = ['']
  const result: DirEntry[] = []
  let visited = 0

  while (queue.length > 0 && result.length < limit && visited < MAX_SEARCH_VISITS) {
    const currentRelative = queue.shift()!
    const currentAbsolute = resolve(root, currentRelative)
    let entries: Dirent[]
    try {
      entries = await fs.readdir(currentAbsolute, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (visited++ >= MAX_SEARCH_VISITS || result.length >= limit) break
      if (DEFAULT_IGNORE.includes(entry.name) || entry.isSymbolicLink()) continue

      const entryRelative = toPosixPath(
        currentRelative ? `${currentRelative}/${entry.name}` : entry.name,
      )
      const isDirectory = entry.isDirectory()
      if (ig.ignores(isDirectory ? `${entryRelative}/` : entryRelative)) continue
      if (isDirectory) queue.push(entryRelative)

      if (!entryRelative.toLocaleLowerCase().includes(normalizedQuery)) continue
      const stat = await fs.stat(resolve(root, entryRelative))
      result.push({
        name: entry.name,
        relativePath: entryRelative,
        isDirectory,
        isSymlink: false,
        size: stat.size,
        modifiedAt: stat.mtimeMs,
      })
    }
  }

  return result.sort(compareSearchResults(normalizedQuery))
}

/**
 * File Preview Dispatch:
 * 按文件类型选择文本、媒体或不可内嵌预览，并限制读取字节数以保护主进程内存。
 *
 * 当 absolutePath 存在时（工作区外文件，如 `~/.claude.json`），跳过工作区边界校验，
 * 直接按绝对路径读取。仍受常规文件校验与大小限制约束。
 */
export async function readFilePreview(
  workspacePath: string,
  relativePath: string,
  absolutePath?: string,
): Promise<FilePreview> {
  // File Preview Path Resolution: 工作区外文件走绝对路径直读，否则经工作区边界校验。
  const resolved = absolutePath
    ? { absolutePath, relativePath }
    : await resolveWorkspaceEntry(workspacePath, relativePath)
  const stat = await fs.stat(resolved.absolutePath)
  if (!stat.isFile()) throw new Error(`not a file: ${relativePath}`)

  const extension = extname(resolved.absolutePath).slice(1).toLowerCase()
  const media = mediaType(extension)
  if (media) {
    const data =
      stat.size <= MAX_MEDIA_PREVIEW_BYTES ? await fs.readFile(resolved.absolutePath) : null
    return previewResult(resolved, stat, {
      kind: media.kind,
      mimeType: media.mimeType,
      isBinary: true,
      dataUrl: data ? `data:${media.mimeType};base64,${data.toString('base64')}` : null,
      truncated: data === null,
    })
  }

  if (extension === 'pdf') {
    const data =
      stat.size <= MAX_MEDIA_PREVIEW_BYTES ? await fs.readFile(resolved.absolutePath) : null
    return previewResult(resolved, stat, {
      kind: 'pdf',
      mimeType: 'application/pdf',
      isBinary: true,
      dataUrl: data ? `data:application/pdf;base64,${data.toString('base64')}` : null,
      truncated: data === null,
    })
  }

  if (DOCUMENT_MIME[extension]) {
    return previewResult(resolved, stat, {
      kind: 'document',
      mimeType: DOCUMENT_MIME[extension]!,
      isBinary: true,
    })
  }

  if (ARCHIVE_MIME[extension]) {
    return previewResult(resolved, stat, {
      kind: 'archive',
      mimeType: ARCHIVE_MIME[extension]!,
      isBinary: true,
    })
  }

  const buffer = await readHead(resolved.absolutePath, MAX_TEXT_PREVIEW_BYTES + 1)
  const binary = isBinaryContent(buffer)
  if (binary) {
    return previewResult(resolved, stat, {
      kind: 'binary',
      mimeType: 'application/octet-stream',
      isBinary: true,
    })
  }

  const truncated = buffer.length > MAX_TEXT_PREVIEW_BYTES
  const content = (truncated ? buffer.subarray(0, MAX_TEXT_PREVIEW_BYTES) : buffer).toString(
    'utf-8',
  )
  const kind: FilePreviewKind = MARKDOWN_EXTENSIONS.has(extension)
    ? 'markdown'
    : TABLE_EXTENSIONS.has(extension)
      ? 'table'
      : 'text'

  return previewResult(resolved, stat, {
    kind,
    mimeType: textMimeType(extension),
    isBinary: false,
    content,
    language: detectLanguage(relativePath),
    truncated,
  })
}

/**
 * Chat File Reference:
 * 将聊天里的路径、file URL 和可选行列号解析为真实文件。
 *
 * 解析顺序（每层只处理自己负责的形态，互不重叠）：
 *   1. 清洗：剥离首尾标点、解码 file:// / % 编码
 *   2. 行列号：parseLineLocation 剥离末尾 :line / #L10 等
 *   3. 家目录展开：~/foo、$HOME/foo → 绝对路径
 *   4. 工作区内：resolveWorkspaceEntry 校验后返回 relativePath
 *   5. 工作区外绝对路径：stat 确认是常规文件后返回 absolutePath
 *   6. 模糊回退：纯文件名/相对后缀在工作区内唯一命中
 *
 * 返回值：工作区内文件只填 relativePath；工作区外文件额外填 absolutePath，
 * relativePath 退化为展示用的原始引用形态（如 `~/.claude.json`）。
 */
export async function resolveFileReference(
  workspacePath: string,
  reference: string,
  options?: { allowDirectory?: boolean },
): Promise<ResolvedFileReference | null> {
  // File Mention: 默认只认常规文件——预览器打不开目录，放行会让 readFilePreview 报错。
  // 只有"把路径引用进对话"这条路径（拖入文件夹、右键点在目录上）才 opt-in 打开它。
  const allowDirectory = options?.allowDirectory === true
  let cleaned = reference.trim()
  const leadingPunctuation = new Set(["'", '"', '`', '(', '<', '['])
  const trailingPunctuation = new Set(["'", '"', '`', ')', '>', ']', '.', ',', ';'])
  while (cleaned[0] && leadingPunctuation.has(cleaned[0])) cleaned = cleaned.slice(1)
  while (cleaned.at(-1) && trailingPunctuation.has(cleaned.at(-1)!)) {
    cleaned = cleaned.slice(0, -1)
  }
  if (cleaned.startsWith('file://')) {
    try {
      cleaned = decodeURIComponent(new URL(cleaned).pathname)
    } catch {
      return null
    }
  } else if (cleaned.includes('%')) {
    try {
      cleaned = decodeURIComponent(cleaned)
    } catch {
      return null
    }
  }

  // 行列号解析（替换旧的行内正则，支持 :line-col 范围与 #L10 锚点）
  const { path: pathPart, line, column } = parseLineLocation(cleaned)
  if (!pathPart) return null

  // 家目录展开：~/foo、$HOME/foo → 绝对路径，走工作区外分支
  const expandedHome = expandHome(pathPart)

  // 绝对路径分支（含展开后的家目录）：尝试工作区内定位，否则走工作区外直读
  const absoluteInput = expandedHome ?? (isAbsolute(pathPart) ? resolve(pathPart) : null)
  if (absoluteInput) {
    // 先尝试作为工作区内文件（绝对路径可能恰好指向工作区内）。
    // 注意 workspacePath 可能含 symlink（如 macOS /var → /private/var），
    // 必须对两边都 realpath 后比较，否则词法判断会误判。
    try {
      const root = await fs.realpath(workspacePath)
      const realCandidate = await fs.realpath(absoluteInput)
      assertWithinRoot(root, realCandidate)
      const stat = await fs.stat(realCandidate)
      if (stat.isFile() || (allowDirectory && stat.isDirectory())) {
        return resolvedFileLocation(
          toPosixPath(relative(root, realCandidate)),
          line,
          column,
          undefined,
          stat.isDirectory(),
        )
      }
    } catch {
      // 不在工作区内或文件不存在，继续尝试工作区外直读
    }
    // 工作区外文件：直接 stat 确认是常规文件后返回 absolutePath
    return resolveOutsideWorkspace(absoluteInput, pathPart, line, column, allowDirectory)
  }

  // 相对路径分支：原有工作区内解析 + 模糊回退
  try {
    const resolved = await resolveWorkspaceEntry(workspacePath, pathPart)
    const stat = await fs.stat(resolved.absolutePath)
    if (!stat.isFile() && !(allowDirectory && stat.isDirectory())) return null
    return resolvedFileLocation(resolved.relativePath, line, column, undefined, stat.isDirectory())
  } catch {
    // Claude History File Reference:
    // 历史回复常把工具路径缩写成 `FilePreview.vue` 或 `components/FilePreview.vue`。
    // 直接按工作区根目录解析会失败，此时仅在工作区内唯一命中时回退，避免同名文件误跳。
    const normalizedSuffix = toPosixPath(pathPart).replace(/^\.\//, '')
    const targetName = basename(normalizedSuffix)
    const matches = (await searchWorkspace(workspacePath, targetName, MAX_SEARCH_RESULTS)).filter(
      (entry) =>
        !entry.isDirectory &&
        entry.name === targetName &&
        (normalizedSuffix === targetName ||
          entry.relativePath === normalizedSuffix ||
          entry.relativePath.endsWith(`/${normalizedSuffix}`)),
    )
    if (matches.length !== 1) return null
    return resolvedFileLocation(matches[0]!.relativePath, line, column)
  }
}

/**
 * Outside Workspace Resolution:
 * 工作区外文件（家目录、绝对路径指向工作区外）的解析。
 * 仅允许常规文件，拒绝目录、字符设备、管道等特殊文件。
 */
async function resolveOutsideWorkspace(
  absolutePath: string,
  displayPath: string,
  line?: number,
  column?: number,
  allowDirectory = false,
): Promise<ResolvedFileReference | null> {
  try {
    const real = await fs.realpath(absolutePath)
    const stat = await fs.stat(real)
    if (!stat.isFile() && !(allowDirectory && stat.isDirectory())) return null
    return resolvedFileLocation(displayPath, line, column, real, stat.isDirectory())
  } catch {
    return null
  }
}

function resolvedFileLocation(
  relativePath: string,
  line?: number,
  column?: number,
  absolutePath?: string,
  isDirectory?: boolean,
): ResolvedFileReference {
  return {
    relativePath,
    ...(absolutePath !== undefined && { absolutePath }),
    ...(line !== undefined && { line }),
    ...(column !== undefined && { column }),
    ...(isDirectory === true && { isDirectory: true }),
  }
}

/** 推断文件的语言（用于 Shiki 高亮）。 */
export function detectLanguage(filename: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (!ext) return null
  const map: Record<string, string> = {
    bash: 'bash',
    c: 'c',
    cc: 'cpp',
    cjs: 'javascript',
    cpp: 'cpp',
    cs: 'csharp',
    css: 'css',
    go: 'go',
    h: 'c',
    hpp: 'cpp',
    html: 'html',
    ini: 'ini',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsonc: 'json',
    jsx: 'jsx',
    kt: 'kotlin',
    lua: 'lua',
    markdown: 'markdown',
    md: 'markdown',
    mjs: 'javascript',
    php: 'php',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    scss: 'scss',
    sh: 'bash',
    sql: 'sql',
    svelte: 'svelte',
    swift: 'swift',
    toml: 'toml',
    ts: 'typescript',
    tsx: 'tsx',
    vue: 'vue',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    zsh: 'bash',
  }
  return map[ext] ?? null
}

/** 检测文件是否二进制（启发式：头部含 NUL 字节）。 */
export function isBinaryContent(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0)
}

async function toDirectoryEntry(
  absoluteParent: string,
  relativeParent: string,
  entry: Dirent,
  ig: Ignore,
): Promise<DirEntry | null> {
  const entryRelative = toPosixPath(relativeParent ? `${relativeParent}/${entry.name}` : entry.name)
  const lstat = await fs.lstat(resolve(absoluteParent, entry.name))
  const isSymlink = lstat.isSymbolicLink()
  let isDirectory = lstat.isDirectory()
  let size = lstat.size
  let modifiedAt = lstat.mtimeMs

  if (isSymlink) {
    try {
      const target = await fs.stat(resolve(absoluteParent, entry.name))
      isDirectory = target.isDirectory()
      size = target.size
      modifiedAt = target.mtimeMs
    } catch {
      return null
    }
  }

  if (ig.ignores(isDirectory ? `${entryRelative}/` : entryRelative)) return null
  return {
    name: entry.name,
    relativePath: entryRelative,
    isDirectory,
    isSymlink,
    size,
    modifiedAt,
  }
}

function assertWithinRoot(root: string, target: string): void {
  const pathFromRoot = relative(root, target)
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error('path is outside the workspace')
  }
}

/**
 * Home Directory Expansion:
 * 把 `~/foo`、`~`、`$HOME/foo` 展开为绝对路径。仅处理明确的前缀，避免误伤普通文件名。
 * 返回 null 表示输入不含家目录前缀，调用方应按原逻辑处理。
 *
 * 可扩展：未来如需支持 `$VAR`、Windows `%USERPROFILE%`，在此统一扩展。
 */
export function expandHome(input: string): string | null {
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return join(homedir(), input.slice(2))
  // $HOME/foo（POSIX）——防御性处理，AI 偶尔输出这种形态
  const homeEnv = process.env.HOME
  if (homeEnv) {
    if (input === '$HOME') return homeEnv
    if (input.startsWith('$HOME/')) return join(homeEnv, input.slice(6))
  }
  return null
}

/**
 * Line Location Parser:
 * 从文件引用末尾解析行列号，返回剥离后的纯路径与位置信息。
 *
 * 支持形态（参考 VS Code terminalLinkParsing，按真实会话频率排序）：
 *   foo.ts:42          → line 42
 *   foo.ts:42:5        → line 42, column 5
 *   foo.ts:42-50       → line 42（行范围取起始行）
 *   foo.ts:42:5-78     → line 42, column 5（行列范围取起始）
 *   foo.ts#L10         → line 10（GitHub 锚点风格）
 *   foo.ts#L10C5       → line 10, column 5
 *   foo.ts(42)         → line 42（MSVC / Rust 编译错误风格）
 *   foo.ts(42,5)       → line 42, column 5
 *   foo.ts 42          → line 42（空格分隔，编译错误）
 *
 * 不匹配则 line/column 均为 undefined，原路径原样返回。
 */
export function parseLineLocation(input: string): { path: string; line?: number; column?: number } {
  // GitHub 锚点风格 #L10 / #L10C5（优先匹配，因为 # 是路径合法字符需特殊处理）
  const anchor = input.match(/^(.*)#L(\d+)(?:C(\d+))?$/)
  if (anchor) {
    const [, head, lineStr, colStr] = anchor
    return {
      path: head!.trim(),
      line: Number(lineStr),
      ...(colStr !== undefined && { column: Number(colStr) }),
    }
  }
  // 冒号风格 :line / :line:col / :line-endline / :line:col-colEnd（行范围取起始行）
  // 路径段不含空格和冒号——避免贪婪匹配吞掉行号，也让含空格的归空格风格分支。
  const colon = input.match(/^([^\s:]+):(\d+)(?::(\d+))?(?:-\d+(?:\.\d+)?)?$/)
  if (colon) {
    const [, head, lineStr, colStr] = colon
    return {
      path: head!.trim(),
      line: Number(lineStr),
      ...(colStr !== undefined && { column: Number(colStr) }),
    }
  }
  // 括号风格 (line) / (line,col) / (line:col)——MSVC / Rust / Clang 编译错误
  const paren = input.match(/^(.*)\((\d+)(?::(\d+)|, ?(\d+))?\)$/)
  if (paren) {
    const [, head, lineStr, colStr, commaColStr] = paren
    const col = colStr ?? commaColStr
    return {
      path: head!.trim(),
      line: Number(lineStr),
      ...(col !== undefined && { column: Number(col) }),
    }
  }
  // 空格风格 "path line" / "path line:col"——部分编译器/工具输出（要求路径段不含空格）
  const space = input.match(/^(\S+) (\d+)(?::(\d+))?$/)
  if (space) {
    const [, head, lineStr, colStr] = space
    return {
      path: head!,
      line: Number(lineStr),
      ...(colStr !== undefined && { column: Number(colStr) }),
    }
  }
  return { path: input }
}

function previewResult(
  resolved: { absolutePath: string; relativePath: string },
  stat: { size: number; mtimeMs: number },
  fields: {
    kind: FilePreviewKind
    mimeType: string
    isBinary: boolean
    content?: string
    dataUrl?: string | null
    language?: string | null
    truncated?: boolean
  },
): FilePreview {
  return {
    relativePath: resolved.relativePath,
    absolutePath: resolved.absolutePath,
    name: basename(resolved.absolutePath),
    size: stat.size,
    mimeType: fields.mimeType,
    kind: fields.kind,
    isBinary: fields.isBinary,
    content: fields.content ?? null,
    dataUrl: fields.dataUrl ?? null,
    language: fields.language ?? null,
    truncated: fields.truncated ?? false,
    encoding: fields.isBinary ? 'binary' : 'utf-8',
    modifiedAt: stat.mtimeMs,
  }
}

/**
 * 扩展名 → 图片 MIME，不是图片返回 null。
 *
 * 导出给 image-thumbnail 用——「哪些扩展名算图片」只该有一份，
 * 缩略图那边再抄一张表迟早会跟这里长歪。
 */
export function imageMimeType(extension: string): string | null {
  return IMAGE_MIME[extension] ?? null
}

function mediaType(
  extension: string,
): { kind: 'image' | 'audio' | 'video'; mimeType: string } | null {
  if (IMAGE_MIME[extension]) return { kind: 'image', mimeType: IMAGE_MIME[extension]! }
  if (AUDIO_MIME[extension]) return { kind: 'audio', mimeType: AUDIO_MIME[extension]! }
  if (VIDEO_MIME[extension]) return { kind: 'video', mimeType: VIDEO_MIME[extension]! }
  return null
}

function textMimeType(extension: string): string {
  if (extension === 'json' || extension === 'jsonc') return 'application/json'
  if (extension === 'csv') return 'text/csv'
  if (extension === 'tsv') return 'text/tab-separated-values'
  if (extension === 'html') return 'text/html'
  if (extension === 'css') return 'text/css'
  return 'text/plain'
}

async function readHead(filePath: string, byteLength: number): Promise<Buffer> {
  const file = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(byteLength)
    const { bytesRead } = await file.read(buffer, 0, byteLength, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

async function loadGitignore(workspacePath: string): Promise<Ignore> {
  const ig = ignore().add(DEFAULT_IGNORE)
  try {
    ig.add(await fs.readFile(resolve(workspacePath, '.gitignore'), 'utf-8'))
  } catch {
    // 工作区没有 .gitignore 时只使用默认规则。
  }
  return ig
}

function compareDirectoryEntries(a: DirEntry, b: DirEntry): number {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

function compareSearchResults(query: string): (a: DirEntry, b: DirEntry) => number {
  return (a, b) => {
    const aName = a.name.toLocaleLowerCase()
    const bName = b.name.toLocaleLowerCase()
    const aStarts = aName.startsWith(query)
    const bStarts = bName.startsWith(query)
    if (aStarts !== bStarts) return aStarts ? -1 : 1
    return a.relativePath.localeCompare(b.relativePath, undefined, {
      numeric: true,
      sensitivity: 'base',
    })
  }
}

function toPosixPath(path: string): string {
  return path.split(sep).join('/')
}
