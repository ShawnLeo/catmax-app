/**
 * 文件浏览服务。
 *
 * 所有 renderer 提供的路径都必须先经过工作区边界校验。目录按需读取，
 * 搜索使用有上限的广度遍历，预览只读取需要的字节，避免大文件占满内存。
 */
import { promises as fs, type Dirent } from 'node:fs'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'

import type { DirEntry, FilePreview, FilePreviewKind } from '@shared/ipc/fs'
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
 */
export async function readFilePreview(
  workspacePath: string,
  relativePath: string,
): Promise<FilePreview> {
  const resolved = await resolveWorkspaceEntry(workspacePath, relativePath)
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
 * 将聊天里的路径、file URL 和可选行列号解析为工作区内的真实文件。
 */
export async function resolveFileReference(
  workspacePath: string,
  reference: string,
): Promise<{ relativePath: string; line?: number; column?: number } | null> {
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

  const location = cleaned.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/)
  const pathPart = location?.[1]?.trim()
  if (!pathPart) return null

  try {
    const resolved = await resolveWorkspaceEntry(workspacePath, pathPart)
    const stat = await fs.stat(resolved.absolutePath)
    if (!stat.isFile()) return null
    return resolvedFileLocation(resolved.relativePath, location?.[2], location?.[3])
  } catch {
    // Claude History File Reference:
    // 历史回复常把工具路径缩写成 `FilePreview.vue` 或 `components/FilePreview.vue`。
    // 直接按工作区根目录解析会失败，此时仅在工作区内唯一命中时回退，避免同名文件误跳。
    if (isAbsolute(pathPart)) return null
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
    return resolvedFileLocation(matches[0]!.relativePath, location?.[2], location?.[3])
  }
}

function resolvedFileLocation(
  relativePath: string,
  lineValue?: string,
  columnValue?: string,
): { relativePath: string; line?: number; column?: number } {
  const line = lineValue ? Number(lineValue) : undefined
  const column = columnValue ? Number(columnValue) : undefined
  return {
    relativePath,
    ...(line !== undefined && { line }),
    ...(column !== undefined && { column }),
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
