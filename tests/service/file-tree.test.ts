import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readDirectory, detectLanguage, isBinaryContent } from '@main/service/file-tree'
import { describe, expect, test, beforeEach, afterEach } from 'vitest'

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
