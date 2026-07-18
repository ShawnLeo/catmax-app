/**
 * 文件树服务 —— gitignore 感知的目录遍历。
 *
 * - 读工作区根的 .gitignore（用 ignore 包解析）
 * - 自动过滤 node_modules / .git / dist / out 等
 * - 不递归进符号链接（避免循环）
 * - 限制返回条目数（防止超大型目录卡死）
 */
import { promises as fs, type Dirent } from 'node:fs'
import { join } from 'node:path'

import type { DirEntry } from '@shared/ipc/fs'
import ignore from 'ignore'

import { logger } from './logger'

const log = logger.domain('file-tree')

/** 默认忽略（即使没 .gitignore 也忽略这些） */
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

const MAX_ENTRIES = 2000

export async function readDirectory(
  workspacePath: string,
  relativePath = '',
  respectGitignore = true,
): Promise<DirEntry[]> {
  const absPath = relativePath ? join(workspacePath, relativePath) : workspacePath
  const ig = respectGitignore ? await loadGitignore(workspacePath) : ignore().add(DEFAULT_IGNORE)

  let entries: Dirent[]
  try {
    entries = await fs.readdir(absPath, { withFileTypes: true })
  } catch (e) {
    log.warn('readDirectory failed:', absPath, e)
    return []
  }

  const result: DirEntry[] = []
  for (const entry of entries) {
    if (result.length >= MAX_ENTRIES) {
      log.warn('hit MAX_ENTRIES, truncating:', absPath)
      break
    }

    const name = entry.name

    // 先过默认 ignore
    if (DEFAULT_IGNORE.includes(name)) continue
    // 再过 .gitignore（用相对工作区根的路径）
    const rel = relativePath ? `${relativePath}/${name}` : name

    let isSymlink = false
    let isDirectory = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      isSymlink = true
      // 解析符号链接：是目录就当目录，否则当文件；不递归（避免循环）
      try {
        const stat = await fs.stat(join(absPath, name))
        isDirectory = stat.isDirectory()
      } catch {
        // 链接断了，跳过
        continue
      }
    }

    // ignore 包：以 trailing slash 测试目录，使 `build/` 这类只匹配目录的模式生效
    const ignorePath = isDirectory ? `${rel}/` : rel
    if (ig.ignores(ignorePath)) continue

    let size = 0
    let modifiedAt = 0
    try {
      const stat = await fs.stat(join(absPath, name))
      size = stat.size
      modifiedAt = stat.mtimeMs
    } catch {
      // 无 stat 信息也能继续
    }

    result.push({
      name,
      relativePath: rel,
      isDirectory,
      isSymlink,
      size,
      modifiedAt,
    })
  }

  // 目录排前面，同类型按名字排序
  result.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return result
}

async function loadGitignore(workspacePath: string): Promise<ignore.Ignore> {
  const ig = ignore().add(DEFAULT_IGNORE)
  try {
    const gitignorePath = join(workspacePath, '.gitignore')
    const content = await fs.readFile(gitignorePath, 'utf-8')
    ig.add(content)
  } catch {
    // 没 .gitignore，只过默认
  }
  return ig
}

/** 推断文件的语言（用于 Shiki 高亮） */
export function detectLanguage(filename: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (!ext) return null
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    mjs: 'javascript',
    cjs: 'javascript',
    vue: 'vue',
    json: 'json',
    jsonc: 'json',
    md: 'markdown',
    markdown: 'markdown',
    css: 'css',
    scss: 'scss',
    html: 'html',
    yml: 'yaml',
    yaml: 'yaml',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    sql: 'sql',
    toml: 'toml',
    ini: 'ini',
    xml: 'xml',
    svg: 'xml',
  }
  return map[ext] ?? null
}

/** 检测文件是否二进制（启发式：含 \0 字节） */
export function isBinaryContent(content: Buffer): boolean {
  return content.slice(0, 8000).includes(0)
}
