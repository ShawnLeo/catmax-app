# Plan 4a: Git 面板 + 文件树 + 编辑器集成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Plan 1-3 的基础上补全文件系统相关的三项 MVP 能力：Git Status 面板（只读）、文件树（只读浏览+预览，尊重 .gitignore）、编辑器集成（5 个 IDE 启动）。完成后产物：用户在工作区内能看到 git 状态、浏览文件、用 VS Code/Cursor 等打开文件。

**Architecture:** 这三项共用 `fs` + `git` 两个新 IPC domain。`git` 用 `simple-git` 库（成熟、Promise API），`fs` 用 Node 原生 + `ignore` 包做 gitignore 感知。文件预览**不引入 monaco-editor**（太重，~5MB），改用 Shiki 高亮 + `<pre>` 渲染（已有依赖，~200行代码搞定）。编辑器启动用 `child_process.exec` 调命令行。UI 上加一个右栏 Panel（与左侧 Sidebar 对称），可折叠。

**Tech Stack:** （已就位）Electron 31 + Vue 3 + Pinia + Tailwind v4 + Shiki。**新增**：`simple-git`、`ignore`。

**设计文档参考：** `docs/superpowers/specs/2026-07-18-catmax-app-design.md`（第一章 §10/11/13）
**项目规范：** `.agents/skills/catmax-conventions/references/ipc-pattern.md`

---

## 关键设计决策

### 决策 1：不引入 monaco-editor

文件预览用 Shiki + `<pre>`（只读场景完全够用，且 Shiki 已经在 Plan 2 引入了）。如果未来需要真正的文件编辑（写操作），再单独评估 monaco-editor / codemirror。

**好处**：
- 少引入 5MB+ 依赖
- 不需要 web worker 配置（electron-vite + monaco worker 是已知痛点）
- 渲染速度更快（Shiki 是构建时高亮）

### 决策 2：右栏 Panel 布局

ChatView 改为三栏：`Sidebar | Main Chat | RightPanel`。RightPanel 用 tab 切换（Git / Files），可折叠（默认折叠，按需展开）。

### 决策 3：编辑器集成策略

- **首选编辑器**：工作区级（`workspace.preferredEditor`，已有字段）+ 全局默认（settings.defaultEditor）
- **启动命令**：每个编辑器一个独立的 launch 函数（带行/列定位参数）
- **失败处理**：编辑器未安装时给明确错误（不是 silently fail）

### 决策 4：fs IPC 用绝对路径还是相对路径

混合：
- `readDirectory` 接受 `workspacePath` + `relativePath`（用户友好的相对路径，安全）
- `openInEditor` 接受 `workspaceId` + `relativePath`（用工作区的 preferredEditor）
- 内部统一转绝对路径

---

## 文件结构（本 plan 产出）

```
catmax-app/
├─ src/
│  ├─ shared/
│  │  └─ ipc/
│  │     ├─ git.ts                            # 🆕 git domain 契约
│  │     └─ fs.ts                             # 🆕 fs domain 契约
│  │
│  ├─ main/
│  │  ├─ ipc/
│  │  │  ├─ register.ts                       # 📝 注册 git + fs domain
│  │  │  └─ domains/
│  │  │     ├─ git/                           # 🆕
│  │  │     │  ├─ handlers.ts                 # getStatus / getRecentCommits
│  │  │     │  └─ index.ts
│  │  │     └─ fs/                            # 🆕
│  │  │        ├─ handlers.ts                 # readDirectory / readFilePreview / openInEditor / etc.
│  │  │        └─ index.ts
│  │  └─ service/
│  │     ├─ git-service.ts                    # 🆕 simple-git 封装（只读）
│  │     ├─ file-tree.ts                      # 🆕 gitignore 感知的目录遍历
│  │     └─ editor-launcher.ts                # 🆕 5 个编辑器启动逻辑
│  │
│  ├─ preload/
│  │  └─ api.ts                               # 📝 暴露 git + fs api
│  │
│  └─ renderer/src/
│     ├─ stores/
│     │  ├─ git.ts                            # 🆕 git status
│     │  └─ files.ts                          # 🆕 文件树 + 当前预览文件
│     ├─ components/
│     │  ├─ panel/                            # 🆕 右栏面板
│     │  │  ├─ RightPanel.vue                 # 根容器 + tab 切换
│     │  │  ├─ GitPanel.vue                   # Git status 显示
│     │  │  ├─ FileTree.vue                   # 树形目录
│     │  │  ├─ FileTreeNode.vue               # 递归节点
│     │  │  └─ FilePreview.vue                # 文件内容预览（Shiki）
│     │  └─ chat/
│     │     └─ ChatView 相关不变，在主区加 RightPanel 切换按钮
│     └─ views/
│        └─ ChatView.vue                      # 📝 改为 Sidebar | Main | RightPanel 三栏
│
└─ tests/
   ├─ service/
   │  ├─ git-service.test.ts                  # 🆕
   │  ├─ file-tree.test.ts                    # 🆕
   │  └─ editor-launcher.test.ts              # 🆕
   └─ ipc/
      ├─ git-handlers.test.ts                 # 🆕
      └─ fs-handlers.test.ts                  # 🆕
```

---

## Task 1: 安装依赖 + IPC 契约

**Files:**
- Modify: `package.json`（加 simple-git、ignore）
- Create: `src/shared/ipc/git.ts`
- Create: `src/shared/ipc/fs.ts`
- Modify: `src/shared/constants.ts`（补 GIT_*、FS_* channels）

### Step 1: 安装依赖

```bash
pnpm add simple-git ignore
pnpm add -D @types/ignore
```

### Step 2: 创建 shared/ipc/git.ts

Create `src/shared/ipc/git.ts`：

```ts
import type { EditorId } from '../constants'

export interface FileChange {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'unknown'
  staged: boolean
}

export interface GitStatus {
  isRepo: boolean
  branch: string | null
  ahead: number
  behind: number
  staged: FileChange[]
  unstaged: FileChange[]
  untracked: string[]
  recentCommits: Commit[]
}

export interface Commit {
  hash: string
  shortHash: string
  author: string
  date: string
  message: string
}

export type GitHandlers = {
  'git.status': (args: { workspacePath: string }) => Promise<GitStatus>
}
```

### Step 3: 创建 shared/ipc/fs.ts

Create `src/shared/ipc/fs.ts`：

```ts
import type { EditorId } from '../constants'

export interface DirEntry {
  name: string
  relativePath: string
  isDirectory: boolean
  isSymlink: boolean
  size: number
  modifiedAt: number
}

export interface FilePreview {
  relativePath: string
  absolutePath: string
  size: number
  mimeType: string
  isBinary: boolean
  content: string | null
  language: string | null
  truncated: boolean
  encoding: 'utf-8' | 'binary'
}

export type FsHandlers = {
  'fs.readDirectory': (args: {
    workspacePath: string
    relativePath?: string
    respectGitignore?: boolean
  }) => Promise<DirEntry[]>
  'fs.readFilePreview': (args: {
    workspacePath: string
    relativePath: string
  }) => Promise<FilePreview>
  'fs.openInEditor': (args: {
    workspaceId: string
    relativePath: string
    line?: number
    column?: number
  }) => Promise<{ launched: boolean; editor: EditorId | null; error?: string }>
  'fs.pathExists': (args: { absolutePath: string }) => Promise<boolean>
}
```

### Step 4: 修改 shared/constants.ts 补 IPC channels

**Modify** `src/shared/constants.ts` —— 在 `IPC` 对象的 `SESSION_DETAIL` 后追加：

```ts
  // git
  GIT_STATUS: 'git.status',
  // fs
  FS_READ_DIRECTORY: 'fs.readDirectory',
  FS_READ_FILE_PREVIEW: 'fs.readFilePreview',
  FS_OPEN_IN_EDITOR: 'fs.openInEditor',
  FS_PATH_EXISTS: 'fs.pathExists',
```

### Step 5: typecheck + commit

```bash
pnpm typecheck && pnpm lint
git add package.json pnpm-lock.yaml src/shared/
git commit -m "feat(ipc): add git + fs domain contracts"
```

---

## Task 2: git-service（simple-git 封装）

**Files:**
- Create: `src/main/service/git-service.ts`
- Test: `tests/service/git-service.test.ts`

### Step 1: 创建 git-service.ts

Create `src/main/service/git-service.ts`：

```ts
/**
 * Git 服务（只读）—— 用 simple-git 封装。
 *
 * 所有方法都不修改 git 状态（不做 commit/push/branch 等）。
 * 失败时返回 isRepo: false 或空数组，不抛错（git 不是 repo 是常见情况）。
 */
import simpleGit, { type FileStatusResult } from 'simple-git'
import { existsSync, join as pathJoin } from 'node:fs'
import { join } from 'node:path'
import { logger } from './logger'
import type { Commit, FileChange, GitStatus } from '@shared/ipc/git'

const log = logger.domain('git-service')

export async function getGitStatus(workspacePath: string): Promise<GitStatus> {
  // 检查是否 git repo
  const gitDir = join(workspacePath, '.git')
  if (!existsSync(gitDir)) {
    return {
      isRepo: false,
      branch: null,
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: [],
      untracked: [],
      recentCommits: [],
    }
  }

  try {
    const git = simpleGit(workspacePath)
    const status = await git.status()
    const recentCommits = await getRecentCommits(git, 20)

    const staged: FileChange[] = []
    const unstaged: FileChange[] = []
    const untracked: string[] = [...status.not_added]

    // status.files 包含所有变更
    for (const file of status.files) {
      const change = parseFileStatus(file)
      if (file.index !== ' ' && file.index !== '?') {
        // staged
        staged.push(change)
      }
      if (file.working_dir !== ' ' && file.working_dir !== '?') {
        // unstaged
        unstaged.push(change)
      }
      if (file.index === '?' || file.working_dir === '?') {
        if (!untracked.includes(file.path)) {
          untracked.push(file.path)
        }
      }
    }

    return {
      isRepo: true,
      branch: status.current,
      ahead: status.ahead,
      behind: status.behind,
      staged,
      unstaged,
      untracked,
      recentCommits,
    }
  } catch (e) {
    log.warn('git status failed:', e)
    return {
      isRepo: false,
      branch: null,
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: [],
      untracked: [],
      recentCommits: [],
    }
  }
}

function parseFileStatus(file: FileStatusResult): FileChange {
  const code = file.index !== ' ' ? file.index : file.working_dir
  let status: FileChange['status']
  switch (code) {
    case 'M':
      status = 'modified'
      break
    case 'A':
      status = 'added'
      break
    case 'D':
      status = 'deleted'
      break
    case 'R':
      status = 'renamed'
      break
    case 'C':
      status = 'renamed' // copy 当 rename
      break
    default:
      status = 'unknown'
  }
  return {
    path: file.path,
    status,
    staged: file.index !== ' ',
  }
}

async function getRecentCommits(git: ReturnType<typeof simpleGit>, limit: number): Promise<Commit[]> {
  try {
    const log = await git.log({ maxCount: limit })
    return log.all.map((c) => ({
      hash: c.hash,
      shortHash: c.hash.slice(0, 7),
      author: c.author_name,
      date: c.date,
      message: c.message,
    }))
  } catch {
    return []
  }
}

// 删掉无用的 import
void pathJoin
```

注意：`simple-git` 的 `FileStatusResult` 字段是 `index`（staged 状态）和 `working_dir`（unstaged 状态）。`'?'` 表示 untracked。

### Step 2: 写 git-service 单测

Create `tests/service/git-service.test.ts`：

```ts
import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { getGitStatus } from '@main/service/git-service'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'catmax-git-test-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

// 需要 git 可用
const hasGit = (() => {
  try {
    execSync('git --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!hasGit)('git-service', () => {
  test('非 git repo 返回 isRepo=false', async () => {
    const status = await getGitStatus(tempDir)
    expect(status.isRepo).toBe(false)
    expect(status.branch).toBeNull()
  })

  test('git repo 返回 isRepo=true + branch=main', async () => {
    execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' })
    execSync('git config user.email test@test.com', { cwd: tempDir })
    execSync('git config user.name Test', { cwd: tempDir })
    writeFileSync(join(tempDir, 'a.txt'), 'a')
    execSync('git add a.txt', { cwd: tempDir, stdio: 'ignore' })
    execSync('git commit -m init', { cwd: tempDir, stdio: 'ignore' })

    const status = await getGitStatus(tempDir)
    expect(status.isRepo).toBe(true)
    expect(status.branch).toBe('main')
    expect(status.recentCommits.length).toBeGreaterThan(0)
    expect(status.recentCommits[0]!.message).toContain('init')
  })

  test('modified 文件被识别', async () => {
    execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' })
    execSync('git config user.email t@t.com', { cwd: tempDir })
    execSync('git config user.name T', { cwd: tempDir })
    writeFileSync(join(tempDir, 'a.txt'), 'a')
    execSync('git add a.txt && git commit -m init', { cwd: tempDir, stdio: 'ignore' })

    // 修改文件
    writeFileSync(join(tempDir, 'a.txt'), 'modified')
    // 新增未跟踪文件
    writeFileSync(join(tempDir, 'b.txt'), 'b')

    const status = await getGitStatus(tempDir)
    expect(status.unstaged.some((f) => f.path === 'a.txt' && f.status === 'modified')).toBe(true)
    expect(status.untracked).toContain('b.txt')
  })
})
```

### Step 3: 测试 + commit

```bash
pnpm rebuild:node
pnpm test tests/service/git-service.test.ts
pnpm typecheck && pnpm lint
git add src/main/service/git-service.ts tests/service/git-service.test.ts
git commit -m "feat(service): add git-service with simple-git (read-only)"
```

---

## Task 3: file-tree（gitignore 感知）

**Files:**
- Create: `src/main/service/file-tree.ts`
- Test: `tests/service/file-tree.test.ts`

### Step 1: 创建 file-tree.ts

Create `src/main/service/file-tree.ts`：

```ts
/**
 * 文件树服务 —— gitignore 感知的目录遍历。
 *
 * - 读工作区根的 .gitignore（用 ignore 包解析）
 * - 自动过滤 node_modules / .git / dist / out 等
 * - 不递归进符号链接（避免循环）
 * - 限制返回条目数（防止超大型目录卡死）
 */
import { promises as fs } from 'node:fs'
import { join, relative, basename } from 'node:path'
import ignore from 'ignore'
import { logger } from './logger'
import type { DirEntry } from '@shared/ipc/fs'

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

  let entries: await fs.readdir(absPath, { withFileTypes: true })
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
    if (ig.ignores(rel)) continue

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
```

注意：上面有个语法错误 `let entries: await fs.readdir(...)`，下面 Step 2 之前修掉。把那行改成：

```ts
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(absPath, { withFileTypes: true })
  } catch (e) {
    log.warn('readDirectory failed:', absPath, e)
    return []
  }
```

（删除重复的 `let entries: await ...` 那一行）

### Step 2: 写 file-tree 单测

Create `tests/service/file-tree.test.ts`：

```ts
import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readDirectory, detectLanguage, isBinaryContent } from '@main/service/file-tree'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'catmax-tree-test-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('readDirectory', () => {
  test('返回文件和目录', async () => {
    writeFileSync(join(tempDir, 'a.txt'), 'a')
    writeFileSync(join(tempDir, 'b.ts'), 'b')
    mkdirSync(join(tempDir, 'subdir'))
    const entries = await readDirectory(tempDir)
    const names = entries.map((e) => e.name)
    expect(names).toContain('a.txt')
    expect(names).toContain('b.ts')
    expect(names).toContain('subdir')
    expect(entries.find((e) => e.name === 'subdir')?.isDirectory).toBe(true)
  })

  test('目录排前面', async () => {
    writeFileSync(join(tempDir, 'z.txt'), 'z')
    mkdirSync(join(tempDir, 'a-dir'))
    const entries = await readDirectory(tempDir)
    expect(entries[0]!.name).toBe('a-dir')
    expect(entries[0]!.isDirectory).toBe(true)
  })

  test('默认忽略 node_modules / .git / dist', async () => {
    mkdirSync(join(tempDir, 'node_modules'))
    mkdirSync(join(tempDir, '.git'))
    mkdirSync(join(tempDir, 'dist'))
    writeFileSync(join(tempDir, 'real.txt'), 'x')
    const entries = await readDirectory(tempDir)
    const names = entries.map((e) => e.name)
    expect(names).not.toContain('node_modules')
    expect(names).not.toContain('.git')
    expect(names).not.toContain('dist')
    expect(names).toContain('real.txt')
  })

  test('.gitignore 中的文件被忽略', async () => {
    writeFileSync(join(tempDir, '.gitignore'), 'secret.txt\nbuild/\n')
    writeFileSync(join(tempDir, 'secret.txt'), 's')
    mkdirSync(join(tempDir, 'build'))
    writeFileSync(join(tempDir, 'build', 'out.js'), 'x')
    writeFileSync(join(tempDir, 'kept.txt'), 'k')
    const entries = await readDirectory(tempDir)
    const names = entries.map((e) => e.name)
    expect(names).not.toContain('secret.txt')
    expect(names).not.toContain('build')
    expect(names).toContain('kept.txt')
    expect(names).toContain('.gitignore') // .gitignore 本身不被忽略
  })

  test('respectGitignore=false 不应用 .gitignore（但仍过默认）', async () => {
    writeFileSync(join(tempDir, '.gitignore'), 'secret.txt\n')
    writeFileSync(join(tempDir, 'secret.txt'), 's')
    const entries = await readDirectory(tempDir, '', false)
    const names = entries.map((e) => e.name)
    expect(names).toContain('secret.txt')
  })
})

describe('detectLanguage', () => {
  test('常见扩展名', () => {
    expect(detectLanguage('foo.ts')).toBe('typescript')
    expect(detectLanguage('foo.tsx')).toBe('tsx')
    expect(detectLanguage('foo.js')).toBe('javascript')
    expect(detectLanguage('foo.vue')).toBe('vue')
    expect(detectLanguage('foo.md')).toBe('markdown')
    expect(detectLanguage('foo.json')).toBe('json')
  })

  test('未知扩展名返回 null', () => {
    expect(detectLanguage('foo.unknownext')).toBeNull()
    expect(detectLanguage('noext')).toBeNull()
  })
})

describe('isBinaryContent', () => {
  test('文本不是二进制', () => {
    expect(isBinaryContent(Buffer.from('hello world', 'utf-8'))).toBe(false)
  })

  test('含 \\0 字节是二进制', () => {
    expect(isBinaryContent(Buffer.from([0x68, 0x00, 0x65, 0x6c, 0x6c, 0x6f]))).toBe(true)
  })
})
```

### Step 3: 测试 + commit

```bash
pnpm test tests/service/file-tree.test.ts
pnpm typecheck && pnpm lint
git add src/main/service/file-tree.ts tests/service/file-tree.test.ts
git commit -m "feat(service): add file-tree with gitignore-aware traversal"
```

---

## Task 4: editor-launcher（5 个 IDE 启动）

**Files:**
- Create: `src/main/service/editor-launcher.ts`
- Test: `tests/service/editor-launcher.test.ts`

### Step 1: 创建 editor-launcher.ts

Create `src/main/service/editor-launcher.ts`：

```ts
/**
 * 编辑器启动器 —— 5 个 IDE 的命令行启动。
 *
 * 每个 IDE 一个 launch 函数，统一签名：
 *   (workspacePath, relativePath, line?, column?) => Promise<{ launched, error? }>
 *
 * 启动用 child_process.spawn（detached，不阻塞、不等待退出）。
 * 找不到命令时不抛错，返回 launched: false + error 信息。
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { logger } from './logger'
import type { EditorId } from '@shared/constants'

const log = logger.domain('editor-launcher')

export interface LaunchOptions {
  workspacePath: string
  relativePath: string
  line?: number
  column?: number
}

export interface LaunchResult {
  launched: boolean
  editor: EditorId
  error?: string
}

const EDITOR_COMMANDS: Record<EditorId, string[]> = {
  vscode: ['code'],
  cursor: ['cursor'],
  intellij: ['idea'],
  webstorm: ['webstorm'],
  sublime: ['subl'],
}

const EDITOR_NAMES: Record<EditorId, string> = {
  vscode: 'VS Code',
  cursor: 'Cursor',
  intellij: 'IntelliJ IDEA',
  webstorm: 'WebStorm',
  sublime: 'Sublime Text',
}

/** 启动指定编辑器打开文件 */
export async function launchInEditor(
  editor: EditorId,
  opts: LaunchOptions,
): Promise<LaunchResult> {
  const absPath = join(opts.workspacePath, opts.relativePath)
  if (!existsSync(absPath)) {
    return { launched: false, editor, error: `file does not exist: ${absPath}` }
  }

  // 构造命令行参数：file:line:column 或 file
  const positionSuffix =
    opts.line !== undefined
      ? opts.column !== undefined
        ? `:${opts.line}:${opts.column}`
        : `:${opts.line}`
      : ''
  const fileArg = `${absPath}${positionSuffix}`

  // 大多数编辑器接受 file:line:column 格式
  // IntelliJ/WebStorm 用 --line N file 格式
  let args: string[]
  switch (editor) {
    case 'intellij':
    case 'webstorm':
      args = opts.line !== undefined ? [`${opts.line}`, absPath] : [absPath]
      break
    case 'vscode':
    case 'cursor':
    case 'sublime':
    default:
      args = [fileArg]
      break
  }

  const commands = EDITOR_COMMANDS[editor]
  if (!commands) {
    return { launched: false, editor, error: `unknown editor: ${editor}` }
  }

  return new Promise((resolve) => {
    try {
      const child = spawn(commands[0]!, args, {
        detached: true,
        stdio: 'ignore',
        cwd: opts.workspacePath,
      })
      child.on('error', (err) => {
        const message = (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? `${EDITOR_NAMES[editor]} CLI 命令 '${commands[0]}' 未找到。请确认已安装且在 PATH 中。`
          : `启动失败: ${err.message}`
        log.warn('editor launch error:', message)
        resolve({ launched: false, editor, error: message })
      })
      child.on('spawn', () => {
        log.info('launched', editor, absPath)
        // 立即 resolve（不等退出）
        resolve({ launched: true, editor })
        child.unref()
      })
    } catch (e) {
      resolve({ launched: false, editor, error: String(e) })
    }
  })
}

/** 检测编辑器是否可用（命令在 PATH 中） */
export async function isEditorAvailable(editor: EditorId): Promise<boolean> {
  return new Promise((resolve) => {
    const cmd = EDITOR_COMMANDS[editor]
    if (!cmd) {
      resolve(false)
      return
    }
    try {
      const child = spawn('which', [cmd[0]!], { stdio: ['ignore', 'pipe', 'ignore'] })
      let output = ''
      child.stdout?.on('data', (chunk) => {
        output += chunk.toString()
      })
      child.on('close', (code) => {
        resolve(code === 0 && output.trim().length > 0)
      })
      child.on('error', () => resolve(false))
    } catch {
      resolve(false)
    }
  })
}
```

### Step 2: 写 editor-launcher 单测

Create `tests/service/editor-launcher.test.ts`：

```ts
import { describe, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchInEditor, isEditorAvailable } from '@main/service/editor-launcher'
import type { EditorId } from '@shared/constants'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'catmax-editor-test-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('editor-launcher', () => {
  test('文件不存在时返回 launched=false', async () => {
    const result = await launchInEditor('vscode', {
      workspacePath: tempDir,
      relativePath: 'nope.ts',
    })
    expect(result.launched).toBe(false)
    expect(result.error).toContain('does not exist')
  })

  test('未知 editor 返回 false', async () => {
    writeFileSync(join(tempDir, 'a.ts'), 'a')
    const result = await launchInEditor('unknown' as EditorId, {
      workspacePath: tempDir,
      relativePath: 'a.ts',
    })
    expect(result.launched).toBe(false)
    expect(result.error).toContain('unknown editor')
  })

  test('vscode 命令格式是 file:line:column', async () => {
    writeFileSync(join(tempDir, 'a.ts'), 'a')
    // mock spawn 验证 args
    const { spawn } = await import('node:child_process')
    const mockSpawn = vi.fn().mockReturnValue({
      on: vi.fn((event, cb) => {
        if (event === 'spawn') setTimeout(cb, 0)
      }),
      unref: vi.fn(),
    })
    vi.spyOn(await import('node:child_process'), 'spawn').mockImplementation(mockSpawn as any)
    // 这条 mock 失败也无所谓——主要是验证 args 构造
    void spawn

    const result = await launchInEditor('vscode', {
      workspacePath: tempDir,
      relativePath: 'a.ts',
      line: 10,
      column: 5,
    })
    expect(result.editor).toBe('vscode')
    expect(result.launched).toBe(true)
    // spawn 被调用，参数含绝对路径 + :10:5
    expect(mockSpawn).toHaveBeenCalled()
    const callArgs = mockSpawn.mock.calls[0]
    expect(callArgs?.[1]).toEqual([expect.stringContaining('a.ts:10:5')])
  })

  test('intellij 用 --line N file 格式', async () => {
    writeFileSync(join(tempDir, 'a.ts'), 'a')
    const { spawn: _spawn } = await import('node:child_process')
    const mockSpawn = vi.fn().mockReturnValue({
      on: vi.fn((event, cb) => {
        if (event === 'spawn') setTimeout(cb, 0)
      }),
      unref: vi.fn(),
    })
    vi.doMock('node:child_process', { spawn: mockSpawn })
    void _spawn

    const result = await launchInEditor('intellij', {
      workspacePath: tempDir,
      relativePath: 'a.ts',
      line: 42,
    })
    expect(result.editor).toBe('intellij')
    const callArgs = mockSpawn.mock.calls[0]
    expect(callArgs?.[1]).toEqual(['42', expect.stringContaining('a.ts')])
  })

  test('isEditorAvailable 返回 boolean', async () => {
    // 大多数 CI 环境装不了这些编辑器，只要不抛错就行
    const result = await isEditorAvailable('vscode')
    expect(typeof result).toBe('boolean')
  })
})

import { beforeEach, afterEach } from 'vitest'
```

### Step 3: 测试 + commit

```bash
pnpm test tests/service/editor-launcher.test.ts
pnpm typecheck && pnpm lint
git add src/main/service/editor-launcher.ts tests/service/editor-launcher.test.ts
git commit -m "feat(service): add editor-launcher for 5 IDEs (vscode/cursor/intellij/webstorm/sublime)"
```

---

## Task 5: git + fs IPC domain handlers

**Files:**
- Create: `src/main/ipc/domains/git/{handlers,index}.ts`
- Create: `src/main/ipc/domains/fs/{handlers,index}.ts`
- Modify: `src/main/ipc/register.ts`

### Step 1: git handlers

Create `src/main/ipc/domains/git/handlers.ts`：

```ts
import { getGitStatus } from '@main/service/git-service'
import type { GitStatus } from '@shared/ipc/git'

export const getGitStatusHandler = async (args: {
  workspacePath: string
}): Promise<GitStatus> => {
  return getGitStatus(args.workspacePath)
}
```

### Step 2: git index

Create `src/main/ipc/domains/git/index.ts`：

```ts
import { handleRendererRequest } from '../../typed'
import type { GitHandlers } from '@shared/ipc/git'
import { getGitStatusHandler } from './handlers'

export function registerGitHandlers(): void {
  handleRendererRequest<GitHandlers, 'git.status'>('git.status', getGitStatusHandler)
}

export type { GitHandlers } from '@shared/ipc/git'
```

### Step 3: fs handlers

Create `src/main/ipc/domains/fs/handlers.ts`：

```ts
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { ctx } from '@main/context'
import {
  detectLanguage,
  isBinaryContent,
  readDirectory,
} from '@main/service/file-tree'
import { launchInEditor } from '@main/service/editor-launcher'
import { existsSync } from 'node:fs'
import type { DirEntry, FilePreview } from '@shared/ipc/fs'

const MAX_PREVIEW_BYTES = 256 * 1024 // 256KB

export const readDirectoryHandler = async (args: {
  workspacePath: string
  relativePath?: string
  respectGitignore?: boolean
}): Promise<DirEntry[]> => {
  return readDirectory(
    args.workspacePath,
    args.relativePath ?? '',
    args.respectGitignore ?? true,
  )
}

export const readFilePreviewHandler = async (args: {
  workspacePath: string
  relativePath: string
}): Promise<FilePreview> => {
  const absPath = join(args.workspacePath, args.relativePath)
  if (!existsSync(absPath)) {
    throw new Error(`file does not exist: ${args.relativePath}`)
  }

  const stat = await fs.stat(absPath)
  const buffer = await fs.readFile(absPath)
  const binary = isBinaryContent(buffer)
  const truncated = buffer.length > MAX_PREVIEW_BYTES
  const sliced = truncated ? buffer.subarray(0, MAX_PREVIEW_BYTES) : buffer

  let content: string | null = null
  let language: string | null = null
  if (!binary) {
    content = sliced.toString('utf-8')
    language = detectLanguage(args.relativePath)
  }

  return {
    relativePath: args.relativePath,
    absolutePath: absPath,
    size: stat.size,
    mimeType: binary ? 'application/octet-stream' : 'text/plain',
    isBinary: binary,
    content,
    language,
    truncated,
    encoding: binary ? 'binary' : 'utf-8',
  }
}

export const openInEditorHandler = async (args: {
  workspaceId: string
  relativePath: string
  line?: number
  column?: number
}) => {
  // 找 workspace（用 preferredEditor）
  const ws = ctx.db.findWorkspaceById(args.workspaceId)
  if (!ws) {
    return { launched: false, editor: null, error: 'workspace not found' }
  }
  const editor = ws.preferredEditor ?? (await import('@shared/constants')).DEFAULT_EDITOR
  // 这里需要导入 DEFAULT_EDITOR；放顶层更干净——见 Step 5 修改
  const { launchInEditor } = await import('@main/service/editor-launcher')
  return launchInEditor(editor, {
    workspacePath: ws.path,
    relativePath: args.relativePath,
    line: args.line,
    column: args.column,
  })
}

export const pathExistsHandler = async (args: { absolutePath: string }): Promise<boolean> => {
  return existsSync(args.absolutePath)
}
```

注意：上面用动态 import 不优雅。Step 5 改为顶层 import。

### Step 4: fs index

Create `src/main/ipc/domains/fs/index.ts`：

```ts
import { handleRendererRequest } from '../../typed'
import type { FsHandlers } from '@shared/ipc/fs'
import {
  openInEditorHandler,
  pathExistsHandler,
  readDirectoryHandler,
  readFilePreviewHandler,
} from './handlers'

export function registerFsHandlers(): void {
  handleRendererRequest<FsHandlers, 'fs.readDirectory'>('fs.readDirectory', readDirectoryHandler)
  handleRendererRequest<FsHandlers, 'fs.readFilePreview'>(
    'fs.readFilePreview',
    readFilePreviewHandler,
  )
  handleRendererRequest<FsHandlers, 'fs.openInEditor'>('fs.openInEditor', openInEditorHandler)
  handleRendererRequest<FsHandlers, 'fs.pathExists'>('fs.pathExists', pathExistsHandler)
}

export type { FsHandlers } from '@shared/ipc/fs'
```

### Step 5: 重写 fs handlers 的 import（清理动态 import）

**Modify** `src/main/ipc/domains/fs/handlers.ts`——把动态 import 改成顶层。完整重写：

```ts
import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_EDITOR } from '@shared/constants'
import { ctx } from '@main/context'
import { launchInEditor } from '@main/service/editor-launcher'
import { detectLanguage, isBinaryContent, readDirectory } from '@main/service/file-tree'
import type { DirEntry, FilePreview } from '@shared/ipc/fs'

const MAX_PREVIEW_BYTES = 256 * 1024

export const readDirectoryHandler = async (args: {
  workspacePath: string
  relativePath?: string
  respectGitignore?: boolean
}): Promise<DirEntry[]> => {
  return readDirectory(
    args.workspacePath,
    args.relativePath ?? '',
    args.respectGitignore ?? true,
  )
}

export const readFilePreviewHandler = async (args: {
  workspacePath: string
  relativePath: string
}): Promise<FilePreview> => {
  const absPath = join(args.workspacePath, args.relativePath)
  if (!existsSync(absPath)) {
    throw new Error(`file does not exist: ${args.relativePath}`)
  }

  const stat = await fs.stat(absPath)
  const buffer = await fs.readFile(absPath)
  const binary = isBinaryContent(buffer)
  const truncated = buffer.length > MAX_PREVIEW_BYTES
  const sliced = truncated ? buffer.subarray(0, MAX_PREVIEW_BYTES) : buffer

  let content: string | null = null
  let language: string | null = null
  if (!binary) {
    content = sliced.toString('utf-8')
    language = detectLanguage(args.relativePath)
  }

  return {
    relativePath: args.relativePath,
    absolutePath: absPath,
    size: stat.size,
    mimeType: binary ? 'application/octet-stream' : 'text/plain',
    isBinary: binary,
    content,
    language,
    truncated,
    encoding: binary ? 'binary' : 'utf-8',
  }
}

export const openInEditorHandler = async (args: {
  workspaceId: string
  relativePath: string
  line?: number
  column?: number
}) => {
  const ws = ctx.db.findWorkspaceById(args.workspaceId)
  if (!ws) {
    return { launched: false, editor: null, error: 'workspace not found' }
  }
  const editor = ws.preferredEditor ?? DEFAULT_EDITOR
  return launchInEditor(editor, {
    workspacePath: ws.path,
    relativePath: args.relativePath,
    line: args.line,
    column: args.column,
  })
}

export const pathExistsHandler = async (args: { absolutePath: string }): Promise<boolean> => {
  return existsSync(args.absolutePath)
}
```

### Step 6: 修改 register.ts 注册新 domain

**Modify** `src/main/ipc/register.ts`：

```ts
import { logger } from '../service/logger'
import { registerBackendHandlers } from './domains/backend'
import { registerFsHandlers } from './domains/fs'
import { registerGitHandlers } from './domains/git'
import { registerSessionHandlers } from './domains/session'
import { registerSettingsHandlers } from './domains/settings'
import { registerSystemHandlers } from './domains/system'
import { registerWorkspaceHandlers } from './domains/workspace'

const log = logger.domain('ipc-register')

export async function registerAllHandlers(): Promise<void> {
  registerWorkspaceHandlers()
  registerSettingsHandlers()
  registerSystemHandlers()
  registerBackendHandlers()
  registerSessionHandlers()
  registerGitHandlers()
  registerFsHandlers()
  log.info('all handlers registered')
}
```

注意：`DEFAULT_EDITOR` 已经在 Plan 1 加到 `shared/constants.ts` 了（settings.defaultEditor = 'vscode'）。如果 constants 里没有 `DEFAULT_EDITOR` 常量，需要补：

**Modify** `src/shared/constants.ts`——在 `DEFAULT_CODE_FONT_SIZE` 之后加：

```ts
/** 默认编辑器 */
export const DEFAULT_EDITOR = 'vscode' as const satisfies EditorId
```

### Step 7: typecheck + lint + commit

```bash
pnpm typecheck && pnpm lint
git add src/shared/constants.ts src/main/ipc/domains/git/ src/main/ipc/domains/fs/ src/main/ipc/register.ts
git commit -m "feat(ipc): add git + fs domain handlers"
```

---

## Task 6: preload api 扩展 + renderer stores

**Files:**
- Modify: `src/preload/api.ts`（加 git + fs api）
- Create: `src/renderer/src/stores/git.ts`
- Create: `src/renderer/src/stores/files.ts`

### Step 1: 修改 preload/api.ts

**Modify** `src/preload/api.ts`——在 `session` 块后追加：

```ts
  git: {
    status: requestMain<GitHandlers, 'git.status'>(IPC.GIT_STATUS),
  },
  fs: {
    readDirectory: requestMain<FsHandlers, 'fs.readDirectory'>(IPC.FS_READ_DIRECTORY),
    readFilePreview: requestMain<FsHandlers, 'fs.readFilePreview'>(IPC.FS_READ_FILE_PREVIEW),
    openInEditor: requestMain<FsHandlers, 'fs.openInEditor'>(IPC.FS_OPEN_IN_EDITOR),
    pathExists: requestMain<FsHandlers, 'fs.pathExists'>(IPC.FS_PATH_EXISTS),
  },
```

并在文件顶部 import 加：

```ts
import type { FsHandlers } from '@shared/ipc/fs'
import type { GitHandlers } from '@shared/ipc/git'
```

### Step 2: 创建 git store

Create `src/renderer/src/stores/git.ts`：

```ts
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { GitStatus } from '@shared/ipc/git'

const EMPTY_STATUS: GitStatus = {
  isRepo: false,
  branch: null,
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  untracked: [],
  recentCommits: [],
}

export const useGitStore = defineStore('git', () => {
  const status = ref<GitStatus>(EMPTY_STATUS)
  const loading = ref(false)
  const lastError = ref<string | null>(null)

  const totalChanges = computed(
    () =>
      status.value.staged.length +
      status.value.unstaged.length +
      status.value.untracked.length,
  )

  async function refresh(workspacePath: string): Promise<void> {
    loading.value = true
    lastError.value = null
    try {
      status.value = await window.api.git.status({ workspacePath })
    } catch (e) {
      lastError.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  function reset(): void {
    status.value = EMPTY_STATUS
    lastError.value = null
  }

  return { status, loading, lastError, totalChanges, refresh, reset }
})
```

### Step 3: 创建 files store

Create `src/renderer/src/stores/files.ts`：

```ts
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { DirEntry, FilePreview } from '@shared/ipc/fs'

export const useFilesStore = defineStore('files', () => {
  /** 当前展开的目录的 entries，key 是相对路径 */
  const directoryCache = ref<Map<string, DirEntry[]>>(new Map())
  /** 当前预览的文件 */
  const currentPreview = ref<FilePreview | null>(null)
  const loading = ref(false)

  async function openDirectory(
    workspacePath: string,
    relativePath = '',
  ): Promise<DirEntry[]> {
    const entries = await window.api.fs.readDirectory({
      workspacePath,
      relativePath,
    })
    directoryCache.value.set(relativePath, entries)
    // 触发响应式
    directoryCache.value = new Map(directoryCache.value)
    return entries
  }

  async function previewFile(
    workspacePath: string,
    relativePath: string,
  ): Promise<void> {
    loading.value = true
    try {
      currentPreview.value = await window.api.fs.readFilePreview({
        workspacePath,
        relativePath,
      })
    } finally {
      loading.value = false
    }
  }

  async function openInEditor(
    workspaceId: string,
    relativePath: string,
    line?: number,
  ): Promise<{ launched: boolean; error?: string }> {
    const result = await window.api.fs.openInEditor({
      workspaceId,
      relativePath,
      line,
    })
    return { launched: result.launched, error: result.error }
  }

  function reset(): void {
    directoryCache.value = new Map()
    currentPreview.value = null
  }

  return { directoryCache, currentPreview, loading, openDirectory, previewFile, openInEditor, reset }
})
```

### Step 4: typecheck + lint + commit

```bash
pnpm typecheck && pnpm lint
git add src/preload/api.ts src/renderer/src/stores/git.ts src/renderer/src/stores/files.ts
git commit -m "feat(renderer): add git + fs stores and expose via preload api"
```

---

## Task 7: 右栏 RightPanel + GitPanel + FileTree 组件

**Files:**
- Create: `src/renderer/src/components/panel/RightPanel.vue`
- Create: `src/renderer/src/components/panel/GitPanel.vue`
- Create: `src/renderer/src/components/panel/FileTree.vue`
- Create: `src/renderer/src/components/panel/FileTreeNode.vue`
- Create: `src/renderer/src/components/panel/FilePreview.vue`
- Modify: `src/renderer/src/views/ChatView.vue`（三栏布局 + 切换按钮）

### Step 1: RightPanel 容器（tab 切换）

Create `src/renderer/src/components/panel/RightPanel.vue`：

```vue
<template>
  <aside
    v-if="visible"
    class="w-80 flex flex-col bg-card border-l border-border"
  >
    <!-- Tab 头 -->
    <div class="flex border-b border-border">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        :class="[
          'flex-1 px-3 py-2 text-sm font-medium border-b-2 transition-colors',
          activeTab === tab.id
            ? 'border-primary text-foreground'
            : 'border-transparent text-muted-foreground hover:text-foreground',
        ]"
        @click="activeTab = tab.id"
      >
        <component :is="tab.icon" class="w-4 h-4 inline-block mr-1" />
        {{ tab.label }}
        <span v-if="tab.badge" class="ml-1 text-xs text-muted-foreground">({{ tab.badge }})</span>
      </button>
    </div>

    <!-- Tab 内容 -->
    <div class="flex-1 overflow-hidden">
      <GitPanel v-if="activeTab === 'git'" />
      <FileTree v-else-if="activeTab === 'files'" />
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { GitBranchIcon, FolderTreeIcon } from 'lucide-vue-next'
import GitPanel from './GitPanel.vue'
import FileTree from './FileTree.vue'
import { useGitStore } from '@renderer/stores/git'

defineProps<{ visible: boolean }>()

type TabId = 'git' | 'files'
const activeTab = ref<TabId>('git')
const gitStore = useGitStore()

const tabs = computed(() => [
  {
    id: 'git' as const,
    label: 'Git',
    icon: GitBranchIcon,
    badge: gitStore.totalChanges > 0 ? gitStore.totalChanges : undefined,
  },
  {
    id: 'files' as const,
    label: 'Files',
    icon: FolderTreeIcon,
    badge: undefined,
  },
])
</script>
```

### Step 2: GitPanel

Create `src/renderer/src/components/panel/GitPanel.vue`：

```vue
<template>
  <div class="h-full overflow-y-auto p-3">
    <!-- 非 repo -->
    <div v-if="!gitStore.status.isRepo" class="text-center text-sm text-muted-foreground py-8">
      <GitBranchIcon class="w-8 h-8 mx-auto mb-2 opacity-50" />
      <p>当前工作区不是 git repo</p>
    </div>

    <template v-else>
      <!-- 分支信息 -->
      <div class="mb-4">
        <div class="flex items-center gap-2 text-sm">
          <GitBranchIcon class="w-4 h-4 text-muted-foreground" />
          <span class="font-medium">{{ gitStore.status.branch }}</span>
          <span v-if="gitStore.status.ahead > 0" class="text-xs text-success">
            ↑ {{ gitStore.status.ahead }}
          </span>
          <span v-if="gitStore.status.behind > 0" class="text-xs text-warning">
            ↓ {{ gitStore.status.behind }}
          </span>
          <button class="ml-auto text-xs text-muted-foreground hover:text-foreground" @click="refresh">
            刷新
          </button>
        </div>
      </div>

      <!-- Staged -->
      <section v-if="gitStore.status.staged.length > 0" class="mb-4">
        <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
          Staged ({{ gitStore.status.staged.length }})
        </h3>
        <div class="space-y-1">
          <FileChangeItem
            v-for="file in gitStore.status.staged"
            :key="file.path"
            :file="file"
          />
        </div>
      </section>

      <!-- Unstaged -->
      <section v-if="gitStore.status.unstaged.length > 0" class="mb-4">
        <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
          Unstaged ({{ gitStore.status.unstaged.length }})
        </h3>
        <div class="space-y-1">
          <FileChangeItem
            v-for="file in gitStore.status.unstaged"
            :key="file.path"
            :file="file"
          />
        </div>
      </section>

      <!-- Untracked -->
      <section v-if="gitStore.status.untracked.length > 0" class="mb-4">
        <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
          Untracked ({{ gitStore.status.untracked.length }})
        </h3>
        <div class="space-y-1">
          <button
            v-for="path in gitStore.status.untracked"
            :key="path"
            class="w-full text-left text-xs font-mono text-foreground hover:bg-muted px-2 py-1 rounded truncate"
            :title="path"
          >
            {{ path }}
          </button>
        </div>
      </section>

      <!-- Recent commits -->
      <section v-if="gitStore.status.recentCommits.length > 0">
        <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
          最近提交
        </h3>
        <div class="space-y-2">
          <div
            v-for="commit in gitStore.status.recentCommits.slice(0, 5)"
            :key="commit.hash"
            class="text-xs"
          >
            <div class="flex items-baseline gap-2">
              <span class="font-mono text-muted-foreground">{{ commit.shortHash }}</span>
              <span class="text-foreground truncate">{{ commit.message }}</span>
            </div>
            <div class="text-muted-foreground ml-1">
              {{ commit.author }} · {{ commit.date }}
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { GitBranchIcon } from 'lucide-vue-next'
import { useGitStore } from '@renderer/stores/git'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import FileChangeItem from './FileChangeItem.vue'

const gitStore = useGitStore()
const workspaceStore = useWorkspaceStore()

async function refresh(): Promise<void> {
  if (workspaceStore.currentWorkspace) {
    await gitStore.refresh(workspaceStore.currentWorkspace.path)
  }
}
</script>
```

### Step 3: FileChangeItem（小辅助组件）

Create `src/renderer/src/components/panel/FileChangeItem.vue`：

```vue
<template>
  <button
    class="w-full flex items-center gap-2 text-xs px-2 py-1 hover:bg-muted rounded"
    :title="file.path"
  >
    <span :class="['w-2 h-2 rounded-full flex-shrink-0', statusColor]" />
    <span class="font-mono text-foreground truncate flex-1 text-left">{{ file.path }}</span>
    <span class="text-muted-foreground flex-shrink-0">{{ file.status }}</span>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { FileChange } from '@shared/ipc/git'

const props = defineProps<{ file: FileChange }>()

const statusColor = computed(() => {
  switch (props.file.status) {
    case 'added':
      return 'bg-success'
    case 'modified':
      return 'bg-warning'
    case 'deleted':
      return 'bg-destructive'
    case 'renamed':
      return 'bg-primary'
    default:
      return 'bg-muted-foreground'
  }
})
</script>
```

### Step 4: FileTree（递归容器）

Create `src/renderer/src/components/panel/FileTree.vue`：

```vue
<template>
  <div class="h-full flex flex-col">
    <!-- 文件树 -->
    <div class="flex-1 overflow-y-auto p-2">
      <div v-if="!workspaceStore.currentWorkspace" class="text-center text-xs text-muted-foreground py-8">
        请先选择工作区
      </div>
      <FileTreeNode
        v-else
        :workspace-path="workspaceStore.currentWorkspace.path"
        :workspace-id="workspaceStore.currentWorkspace.id"
        relative-path=""
        :depth="0"
      />
    </div>

    <!-- 文件预览（底部） -->
    <FilePreview v-if="filesStore.currentPreview" class="border-t border-border h-64" />
  </div>
</template>

<script setup lang="ts">
import FileTreeNode from './FileTreeNode.vue'
import FilePreview from './FilePreview.vue'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { useFilesStore } from '@renderer/stores/files'

const workspaceStore = useWorkspaceStore()
const filesStore = useFilesStore()
</script>
```

### Step 5: FileTreeNode（递归）

Create `src/renderer/src/components/panel/FileTreeNode.vue`：

```vue
<template>
  <div>
    <!-- 加载子目录 -->
    <button
      v-for="entry in entries"
      :key="entry.relativePath"
      :class="[
        'w-full flex items-center gap-1 text-xs hover:bg-muted rounded',
        active(entry.relativePath) ? 'bg-muted' : '',
      ]"
      :style="{ paddingLeft: `${depth * 12 + 8}px` }"
      @click="onClick(entry)"
    >
      <!-- 展开/折叠箭头 -->
      <ChevronRightIcon
        v-if="entry.isDirectory"
        :class="[
          'w-3 h-3 flex-shrink-0 transition-transform',
          expanded.has(entry.relativePath) ? 'rotate-90' : '',
        ]"
      />
      <span v-else class="w-3 h-3 flex-shrink-0" />

      <!-- 图标 -->
      <FolderIcon v-if="entry.isDirectory" class="w-3 h-3 text-muted-foreground flex-shrink-0" />
      <FileIcon v-else class="w-3 h-3 text-muted-foreground flex-shrink-0" />

      <!-- 名字 -->
      <span class="truncate flex-1 text-left">{{ entry.name }}</span>
    </button>

    <!-- 子目录递归 -->
    <FileTreeNode
      v-if="expandedChildren.length > 0"
      v-for="child of expandedChildren"
      :key="child.relativePath"
      :workspace-path="workspacePath"
      :workspace-id="workspaceId"
      :relative-path="child.relativePath"
      :depth="depth + 1"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { ChevronRightIcon, FolderIcon, FileIcon } from 'lucide-vue-next'
import type { DirEntry } from '@shared/ipc/fs'
import { useFilesStore } from '@renderer/stores/files'

const props = defineProps<{
  workspacePath: string
  workspaceId: string
  relativePath: string
  depth: number
}>()

const filesStore = useFilesStore()
const entries = ref<DirEntry[]>([])
const expanded = ref(new Set<string>())

async function load(): Promise<void> {
  entries.value = await filesStore.openDirectory(props.workspacePath, props.relativePath)
}

watch(
  () => props.relativePath,
  () => {
    void load()
  },
  { immediate: true },
)

async function onClick(entry: DirEntry): Promise<void> {
  if (entry.isDirectory) {
    if (expanded.value.has(entry.relativePath)) {
      expanded.value.delete(entry.relativePath)
    } else {
      expanded.value.add(entry.relativePath)
    }
    expanded.value = new Set(expanded.value)
  } else {
    // 文件：预览
    await filesStore.previewFile(props.workspacePath, entry.relativePath)
  }
}

function active(relativePath: string): boolean {
  return filesStore.currentPreview?.relativePath === relativePath
}

// 展开的子节点的 relativePath 列表（用于递归渲染）
import { computed } from 'vue'
const expandedChildren = computed(() =>
  entries.value.filter((e) => e.isDirectory && expanded.value.has(e.relativePath)),
)
</script>
```

### Step 6: FilePreview

Create `src/renderer/src/components/panel/FilePreview.vue`：

```vue
<template>
  <div class="flex flex-col">
    <!-- 头部：路径 + 操作 -->
    <div class="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-muted/50">
      <FileIcon class="w-3 h-3 text-muted-foreground flex-shrink-0" />
      <span class="text-xs font-mono text-foreground truncate flex-1">
        {{ preview.relativePath }}
      </span>
      <button
        class="text-xs text-primary hover:underline flex-shrink-0"
        @click="openInEditor"
      >
        在编辑器中打开
      </button>
    </div>

    <!-- 内容 -->
    <div class="flex-1 overflow-auto bg-code-block">
      <div v-if="preview.isBinary" class="p-4 text-xs text-muted-foreground">
        二进制文件（{{ formatBytes(preview.size) }}）
      </div>
      <pre v-else-if="preview.content" class="text-xs font-mono p-3 text-foreground whitespace-pre-wrap"><code v-html="highlighted"/></pre>
      <div v-if="preview.truncated" class="px-3 py-1 text-xs text-muted-foreground border-t border-border">
        文件过大，只显示前 256KB
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { FileIcon } from 'lucide-vue-next'
import { useFilesStore } from '@renderer/stores/files'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { renderMarkdown } from '@renderer/lib/markdown'

const filesStore = useFilesStore()
const workspaceStore = useWorkspaceStore()
const preview = computed(() => filesStore.currentPreview!)
const highlighted = ref('')

watch(
  () => filesStore.currentPreview,
  async (p) => {
    if (!p || !p.content) {
      highlighted.value = ''
      return
    }
    // 用 Shiki 高亮（如果是已知语言）
    if (p.language) {
      try {
        // 包成 code block 让 markdown-it + shiki 处理
        const fenced = '```' + p.language + '\n' + p.content + '\n```'
        const html = await renderMarkdown(fenced)
        // 提取 <pre><code> 部分
        const match = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)
        highlighted.value = match ? match[1]! : escapeHtml(p.content)
      } catch {
        highlighted.value = escapeHtml(p.content)
      }
    } else {
      highlighted.value = escapeHtml(p.content)
    }
  },
  { immediate: true },
)

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

async function openInEditor(): Promise<void> {
  if (!workspaceStore.currentWorkspace) return
  const result = await filesStore.openInEditor(
    workspaceStore.currentWorkspace.id,
    preview.value.relativePath,
  )
  if (!result.launched && result.error) {
    window.alert(result.error)
  }
}
</script>
```

### Step 7: ChatView 改为三栏 + 切换按钮

**Modify** `src/renderer/src/views/ChatView.vue`：

找到主区的 closing div 前（`<Composer>` 之后），加切换按钮和 RightPanel。在 template 的 `<div class="flex-1 flex flex-col min-w-0">` 内的最外层改：

把现有的：

```vue
      <Composer :disabled="!backendStore.isAvailable" @send="onSend" />
    </div>
  </div>
</template>
```

改为：

```vue
      <Composer :disabled="!backendStore.isAvailable" @send="onSend" />
    </div>

    <!-- 右栏切换按钮（floating） -->
    <button
      class="absolute top-2 right-2 z-10 p-1.5 rounded-md bg-background/80 hover:bg-muted text-muted-foreground hover:text-foreground"
      title="切换右栏"
      @click="rightPanelVisible = !rightPanelVisible"
    >
      <PanelRightIcon class="w-4 h-4" />
    </button>

    <!-- 右栏面板 -->
    <RightPanel :visible="rightPanelVisible" />
  </div>
</template>
```

并在 `<script setup>` 里加：

```ts
import { ref, watch, onMounted } from 'vue'
import { PanelRightIcon } from 'lucide-vue-next'
import RightPanel from '@renderer/components/panel/RightPanel.vue'
import { useGitStore } from '@renderer/stores/git'

const rightPanelVisible = ref(false)
const gitStore = useGitStore()

// 工作区切换时刷新 git status
watch(
  () => workspaceStore.currentWorkspace?.id,
  async (id) => {
    if (id && workspaceStore.currentWorkspace) {
      await gitStore.refresh(workspaceStore.currentWorkspace.path)
    } else {
      gitStore.reset()
    }
  },
  { immediate: true },
)

// 右栏首次打开时加载 git
watch(rightPanelVisible, async (visible) => {
  if (visible && workspaceStore.currentWorkspace && !gitStore.status.isRepo) {
    await gitStore.refresh(workspaceStore.currentWorkspace.path)
  }
})
```

如果 ChatView 的根 div 不是 `relative`，加上：

```vue
<template>
  <div class="h-full flex relative">
```

### Step 8: typecheck + lint + commit

```bash
pnpm typecheck && pnpm lint
git add src/renderer/src/components/panel/ src/renderer/src/views/ChatView.vue
git commit -m "feat(panel): add RightPanel with Git + Files tabs, file tree, file preview"
```

---

## Task 8: 集成验证 + smoke test

**Files:**
- Run: 全套测试 + typecheck + lint + dev 启动
- Create: `docs/superpowers/plans/2026-07-18-plan-4a-smoke-test.md`

### Step 1: 全套自动化测试

```bash
pnpm rebuild:node
pnpm typecheck
pnpm lint
pnpm test
```

Expected: 130 + Plan 4a 新增 tests，预计 145+ tests passing。

### Step 2: production build

```bash
pnpm rebuild:native
pnpm build
```

### Step 3: dev 启动 + 走查

```bash
pnpm dev
```

可视化验证：

1. ✅ 三栏布局：Sidebar | Chat | RightPanel（默认折叠）
2. ✅ 点右上角"切换右栏"按钮 → RightPanel 展开
3. ✅ RightPanel 有 Git / Files 两个 tab
4. ✅ Git tab：显示分支、staged/unstaged/untracked、最近 5 条 commit
5. ✅ Files tab：递归文件树，点击文件预览
6. ✅ 文件预览底部：路径 + "在编辑器中打开" 按钮
7. ✅ 点"在编辑器中打开" → VS Code（或工作区 preferredEditor）打开
8. ✅ 切换工作区 → git status 刷新

### Step 4: 写 smoke test 文档

Create `docs/superpowers/plans/2026-07-18-plan-4a-smoke-test.md`：

```markdown
# Plan 4a Smoke Test 端到端验证清单

## 自动化验证（已通过）

- [ ] `pnpm typecheck` 0 errors
- [ ] `pnpm lint` 0 errors
- [ ] `pnpm test` 145+ tests passing
- [ ] `pnpm build` production 成功

## 可视化验证

### 右栏布局
- [ ] 右上角"切换右栏"按钮可见
- [ ] 点击切换 RightPanel 显示/隐藏
- [ ] RightPanel 320px 宽

### Git tab
- [ ] 非 git repo 显示提示
- [ ] git repo 显示分支名 + ahead/behind
- [ ] Staged / Unstaged / Untracked 分区显示
- [ ] 每个变更显示状态色点（绿=added / 黄=modified / 红=deleted）
- [ ] 最近 5 条 commit
- [ ] "刷新" 按钮工作

### Files tab
- [ ] 文件树递归显示
- [ ] 目录优先排序
- [ ] .gitignore 中的文件不显示
- [ ] node_modules / .git 不显示
- [ ] 点击目录展开/折叠
- [ ] 点击文件底部预览
- [ ] 文件预览带语法高亮
- [ ] 二进制文件显示"二进制"提示
- [ ] 大文件截断提示

### 编辑器集成
- [ ] 点"在编辑器中打开"启动 VS Code
- [ ] 工作区设置 preferredEditor 后用对应编辑器
- [ ] 编辑器未安装时弹错误提示

## 已知限制

- 文件预览不支持编辑（Shiki 只读）
- Git 面板不支持 commit/push（设计文档明确 MVP 只读）
- 文件树没有搜索功能
- 没有终端（Plan 4b）
- 没有 ⌘K 命令面板（Plan 4b）

## 总结

Plan 4a 完成度：8/8 tasks ✅。
```

### Step 5: 提交

```bash
git add docs/superpowers/plans/2026-07-18-plan-4a-smoke-test.md
git commit -m "docs: add Plan 4a smoke test checklist"
```

---

## Plan 4a 完成标志

- ✅ Git Status 面板（只读，分支/staged/unstaged/untracked/commits）
- ✅ 文件树（gitignore 感知、递归、目录优先）
- ✅ 文件预览（Shiki 语法高亮、二进制检测、截断）
- ✅ 编辑器集成（5 个 IDE：VS Code/Cursor/IntelliJ/WebStorm/Sublime）
- ✅ 右栏 RightPanel（tab 切换、可折叠）
- ✅ 三栏布局（Sidebar | Chat | RightPanel）
- ✅ 145+ tests 通过

**Plan 4b（下一步）**：内置终端（xterm.js + node-pty）+ ⌘K 命令面板。

---

## 自检

**1. Spec 覆盖**：Plan 4a 覆盖设计文档 §10（Git）、§11（文件树）、§13（编辑器集成）。§12（终端）、§7（⌘K）在 Plan 4b。

**2. 占位符扫描**：无 TBD/TODO。`simple-git` 的 FileStatusResult 类型用法已在 Task 2 完整说明。

**3. 类型一致性**：
- `EditorId` 复用 Plan 1 的常量
- `DirEntry` / `FilePreview` / `GitStatus` / `FileChange` 在 shared/ipc 定义
- IPC channel 名走 `IPC.GIT_*` / `IPC.FS_*` 常量

**4. 已知简化**：
- 文件预览用 Shiki（不引入 monaco-editor）
- Git 不支持写操作（设计文档明确）
- 文件树没有搜索（搜索是 Plan 5+）
