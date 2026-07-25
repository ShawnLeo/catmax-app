import { mkdtempSync, realpathSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  detectLanguage,
  expandHome,
  isBinaryContent,
  parseLineLocation,
  readDirectory,
  readFilePreview,
  resolveFileReference,
  resolveWorkspaceEntry,
  searchWorkspace,
} from '@main/service/file-tree'
import { describe, expect, test, beforeEach, afterEach } from 'vitest'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'catmax-tree-test-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

// File Tree Security: 目录读取测试同时守住忽略规则与工作区路径边界。
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

  test('拒绝通过 .. 读取工作区外路径', async () => {
    const parent = join(tempDir, '..')
    const outside = join(parent, `outside-${Date.now()}.txt`)
    writeFileSync(outside, 'secret')
    try {
      await expect(
        resolveWorkspaceEntry(tempDir, `../${outside.split('/').pop()}`),
      ).rejects.toThrow('outside the workspace')
    } finally {
      rmSync(outside, { force: true })
    }
  })

  test('拒绝指向工作区外部的符号链接', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'catmax-tree-outside-'))
    writeFileSync(join(outsideDir, 'secret.txt'), 'secret')
    symlinkSync(outsideDir, join(tempDir, 'external'))
    try {
      await expect(resolveWorkspaceEntry(tempDir, 'external/secret.txt')).rejects.toThrow(
        'outside the workspace',
      )
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })
})

// File Preview Matrix: 覆盖主要预览类别、读取上限、搜索和聊天文件引用。
describe('file preview and search', () => {
  test('文本预览带语言和内容', async () => {
    writeFileSync(join(tempDir, 'hello.ts'), 'export const value = 42\n')
    const preview = await readFilePreview(tempDir, 'hello.ts')
    expect(preview.kind).toBe('text')
    expect(preview.language).toBe('typescript')
    expect(preview.content).toContain('value = 42')
    expect(preview.dataUrl).toBeNull()
  })

  test('图片预览返回 data URL', async () => {
    writeFileSync(join(tempDir, 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const preview = await readFilePreview(tempDir, 'pixel.png')
    expect(preview.kind).toBe('image')
    expect(preview.mimeType).toBe('image/png')
    expect(preview.dataUrl).toMatch(/^data:image\/png;base64,/)
  })

  test('表格和办公文档按类型分类', async () => {
    writeFileSync(join(tempDir, 'data.csv'), 'name,value\ncat,1\n')
    writeFileSync(join(tempDir, 'report.docx'), Buffer.from([0x50, 0x4b]))
    expect((await readFilePreview(tempDir, 'data.csv')).kind).toBe('table')
    expect((await readFilePreview(tempDir, 'report.docx')).kind).toBe('document')
  })

  test('大文本只读预览上限并标记 truncated', async () => {
    writeFileSync(join(tempDir, 'large.txt'), 'a'.repeat(600 * 1024))
    const preview = await readFilePreview(tempDir, 'large.txt')
    expect(preview.truncated).toBe(true)
    expect(Buffer.byteLength(preview.content ?? '')).toBe(512 * 1024)
  })

  test('搜索递归查找并遵守 gitignore', async () => {
    mkdirSync(join(tempDir, 'src'))
    mkdirSync(join(tempDir, 'ignored'))
    writeFileSync(join(tempDir, '.gitignore'), 'ignored/\n')
    writeFileSync(join(tempDir, 'src', 'FileTree.vue'), '<template />')
    writeFileSync(join(tempDir, 'ignored', 'HiddenTree.vue'), '<template />')
    const results = await searchWorkspace(tempDir, 'tree')
    expect(results.map((entry) => entry.relativePath)).toEqual(['src/FileTree.vue'])
  })

  test('解析聊天中的文件位置引用', async () => {
    mkdirSync(join(tempDir, 'src'))
    writeFileSync(join(tempDir, 'src', 'main.ts'), 'main')
    writeFileSync(join(tempDir, 'with space.md'), '# title')
    await expect(resolveFileReference(tempDir, 'src/main.ts:12:4')).resolves.toEqual({
      relativePath: 'src/main.ts',
      line: 12,
      column: 4,
    })
    await expect(resolveFileReference(tempDir, 'with%20space.md')).resolves.toEqual({
      relativePath: 'with space.md',
    })
  })

  test('Claude 历史中的唯一文件名和路径后缀可以解析', async () => {
    mkdirSync(join(tempDir, 'src'))
    mkdirSync(join(tempDir, 'src', 'components'))
    writeFileSync(join(tempDir, 'src', 'components', 'FilePreview.vue'), '<template />')

    await expect(resolveFileReference(tempDir, 'FilePreview.vue')).resolves.toEqual({
      relativePath: 'src/components/FilePreview.vue',
    })
    await expect(resolveFileReference(tempDir, 'components/FilePreview.vue:12')).resolves.toEqual({
      relativePath: 'src/components/FilePreview.vue',
      line: 12,
    })
  })

  test('Claude 历史中的文件名有多个匹配时不猜测', async () => {
    mkdirSync(join(tempDir, 'a'))
    mkdirSync(join(tempDir, 'b'))
    writeFileSync(join(tempDir, 'a', 'index.ts'), 'a')
    writeFileSync(join(tempDir, 'b', 'index.ts'), 'b')

    await expect(resolveFileReference(tempDir, 'index.ts')).resolves.toBeNull()
  })
})

// Chat File Reference Advanced: 工作区外文件（家目录/绝对路径）与高级行号语法。
// 这些场景源自真实 claude 会话：AI 常引用 ~/.claude.json、绝对路径、带行范围的路径。
describe('resolveFileReference 工作区外与高级路径', () => {
  test('家目录路径 ~/ 展开为绝对路径并返回 absolutePath', async () => {
    // 用真实 home 目录下的临时文件验证 ~/ 展开
    const homeFile = join(homedir(), '.catmax-test-tilde.json')
    writeFileSync(homeFile, '{"test":true}')
    try {
      const resolved = await resolveFileReference(tempDir, '~/.catmax-test-tilde.json')
      expect(resolved).not.toBeNull()
      expect(resolved!.absolutePath).toBe(homeFile)
      expect(resolved!.relativePath).toBe('~/.catmax-test-tilde.json')
    } finally {
      rmSync(homeFile, { force: true })
    }
  })

  test('绝对路径指向工作区外文件返回 absolutePath', async () => {
    const outsideFile = join(tmpdir(), 'catmax-outside-test.txt')
    writeFileSync(outsideFile, 'outside')
    try {
      const resolved = await resolveFileReference(tempDir, outsideFile)
      expect(resolved).not.toBeNull()
      // realpath 解析 symlink（macOS /var → /private/var），故用 realpath 比较
      expect(resolved!.absolutePath).toBe(realpathSync(outsideFile))
    } finally {
      rmSync(outsideFile, { force: true })
    }
  })

  test('绝对路径指向工作区内文件返回 relativePath（无 absolutePath）', async () => {
    mkdirSync(join(tempDir, 'src'))
    writeFileSync(join(tempDir, 'src', 'main.ts'), 'main')
    const absPath = join(tempDir, 'src', 'main.ts')
    const resolved = await resolveFileReference(tempDir, absPath)
    expect(resolved).toEqual({ relativePath: 'src/main.ts' })
    expect(resolved!.absolutePath).toBeUndefined()
  })

  test('行范围 foo.ts:42-50 取起始行，不残留到路径', async () => {
    mkdirSync(join(tempDir, 'src'))
    writeFileSync(join(tempDir, 'src', 'range.ts'), 'code')
    const resolved = await resolveFileReference(tempDir, 'src/range.ts:42-50')
    expect(resolved).toEqual({ relativePath: 'src/range.ts', line: 42 })
  })

  test('GitHub 锚点 foo.ts#L10 解析行号', async () => {
    writeFileSync(join(tempDir, 'anchor.ts'), 'code')
    const resolved = await resolveFileReference(tempDir, 'anchor.ts#L10')
    expect(resolved).toEqual({ relativePath: 'anchor.ts', line: 10 })
  })

  test('不存在的家目录路径返回 null', async () => {
    await expect(resolveFileReference(tempDir, '~/nonexistent-catmax-test.xyz')).resolves.toBeNull()
  })
})

describe('expandHome', () => {
  test('~/ 展开为家目录', () => {
    expect(expandHome('~/foo')).toBe(join(homedir(), 'foo'))
    expect(expandHome('~')).toBe(homedir())
  })

  test('普通路径返回 null（不含家目录前缀）', () => {
    expect(expandHome('src/foo.ts')).toBeNull()
    expect(expandHome('/abs/path')).toBeNull()
    expect(expandHome('foo.ts')).toBeNull()
  })
})

describe('parseLineLocation', () => {
  test(':line 风格', () => {
    expect(parseLineLocation('foo.ts:42')).toEqual({ path: 'foo.ts', line: 42 })
    expect(parseLineLocation('foo.ts:42:5')).toEqual({ path: 'foo.ts', line: 42, column: 5 })
  })

  test(':line-endline 行范围取起始行', () => {
    expect(parseLineLocation('foo.ts:42-50')).toEqual({ path: 'foo.ts', line: 42 })
  })

  test('#L10 GitHub 锚点', () => {
    expect(parseLineLocation('foo.ts#L10')).toEqual({ path: 'foo.ts', line: 10 })
    expect(parseLineLocation('foo.ts#L10C5')).toEqual({ path: 'foo.ts', line: 10, column: 5 })
  })

  test('无行号的纯路径', () => {
    expect(parseLineLocation('foo.ts')).toEqual({ path: 'foo.ts' })
    expect(parseLineLocation('src/foo bar.ts')).toEqual({ path: 'src/foo bar.ts' })
  })

  test('括号风格 (line) / (line,col) —— MSVC / Rust 编译错误', () => {
    expect(parseLineLocation('foo.ts(42)')).toEqual({ path: 'foo.ts', line: 42 })
    expect(parseLineLocation('foo.ts(42,5)')).toEqual({ path: 'foo.ts', line: 42, column: 5 })
    expect(parseLineLocation('foo.ts(42:5)')).toEqual({ path: 'foo.ts', line: 42, column: 5 })
  })

  test('空格风格 "path line" —— 编译器输出', () => {
    expect(parseLineLocation('foo.ts 42')).toEqual({ path: 'foo.ts', line: 42 })
    expect(parseLineLocation('foo.ts 42:5')).toEqual({ path: 'foo.ts', line: 42, column: 5 })
  })

  test('行列范围 :line:col-colEnd', () => {
    expect(parseLineLocation('foo.ts:42:5-78')).toEqual({ path: 'foo.ts', line: 42, column: 5 })
    expect(parseLineLocation('foo.ts:42-50.78')).toEqual({ path: 'foo.ts', line: 42 })
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
