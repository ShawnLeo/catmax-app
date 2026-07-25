import { describe, expect, test } from 'vitest'

import { looksLikeFileReference } from './file-reference'

// File Reference Detection: 误判防护是核心目标——宁可漏判，不可把非文件标记成可点击。
describe('looksLikeFileReference - 应判定为文件引用（true）', () => {
  test('工作区内相对路径', () => {
    expect(looksLikeFileReference('src/foo.ts')).toBe(true)
    expect(looksLikeFileReference('src/components/FilePreview.vue')).toBe(true)
    expect(looksLikeFileReference('package.json')).toBe(true)
  })

  test('显式相对路径前缀', () => {
    expect(looksLikeFileReference('./foo.ts')).toBe(true)
    expect(looksLikeFileReference('../bar/baz.js')).toBe(true)
  })

  test('绝对路径', () => {
    expect(looksLikeFileReference('/Users/shawn/foo.ts')).toBe(true)
    expect(looksLikeFileReference('/etc/hosts')).toBe(true)
  })

  test('家目录路径', () => {
    expect(looksLikeFileReference('~/.claude.json')).toBe(true)
    expect(looksLikeFileReference('~/foo/bar.md')).toBe(true)
  })

  test('纯 basename 带已知扩展名', () => {
    expect(looksLikeFileReference('FilePreview.vue')).toBe(true)
    expect(looksLikeFileReference('adapter.ts')).toBe(true)
    expect(looksLikeFileReference('README.md')).toBe(true)
  })

  test('dotfile 带扩展名', () => {
    expect(looksLikeFileReference('.env')).toBe(true)
    expect(looksLikeFileReference('.eslintrc.json')).toBe(true)
  })

  test('带行号后缀', () => {
    expect(looksLikeFileReference('foo.ts:42')).toBe(true)
    expect(looksLikeFileReference('foo.ts:42:5')).toBe(true)
    expect(looksLikeFileReference('foo.ts:42-50')).toBe(true)
    expect(looksLikeFileReference('foo.ts#L10')).toBe(true)
    expect(looksLikeFileReference('src/foo.ts:42')).toBe(true)
  })
})

describe('looksLikeFileReference - 应排除的非文件（false）', () => {
  test('变量属性访问（可选链）', () => {
    // 用户报告的误判：workspaceStore.currentWorkspace?.name
    expect(looksLikeFileReference('workspaceStore.currentWorkspace?.name')).toBe(false)
    expect(looksLikeFileReference('obj?.property')).toBe(false)
    expect(looksLikeFileReference('config.value.type')).toBe(false)
  })

  test('环境变量赋值', () => {
    // 用户报告的误判：ANTHROPIC_BASE_URL=https://www.catmax.cn
    expect(looksLikeFileReference('ANTHROPIC_BASE_URL=https://www.catmax.cn')).toBe(false)
    expect(looksLikeFileReference('NODE_ENV=production')).toBe(false)
    expect(looksLikeFileReference('FOO=bar.ts')).toBe(false)
  })

  test('域名（无路径前缀）', () => {
    expect(looksLikeFileReference('www.catmax.cn')).toBe(false)
    expect(looksLikeFileReference('example.com')).toBe(false)
    expect(looksLikeFileReference('registry.npmjs.org')).toBe(false)
  })

  test('URL（含协议）', () => {
    expect(looksLikeFileReference('https://example.com')).toBe(false)
    expect(looksLikeFileReference('http://foo.bar/baz')).toBe(false)
  })

  test('装饰器 / 提及', () => {
    expect(looksLikeFileReference('@Component')).toBe(false)
    expect(looksLikeFileReference('@Injectable()')).toBe(false)
  })

  test('URL 查询参数', () => {
    expect(looksLikeFileReference('foo?a=1&b=2')).toBe(false)
    expect(looksLikeFileReference('key=value.ts')).toBe(false)
  })

  test('函数调用 / 代码片段（VS Code ExcludedPathCharactersClause 对齐）', () => {
    expect(looksLikeFileReference('foo(bar.ts)')).toBe(false)
    expect(looksLikeFileReference('fn(arg)')).toBe(false)
    expect(looksLikeFileReference('a*b.ts')).toBe(false)
    expect(looksLikeFileReference('foo;bar.ts')).toBe(false)
    expect(looksLikeFileReference('foo|bar')).toBe(false)
  })

  test('纯单词无扩展名', () => {
    expect(looksLikeFileReference('foo')).toBe(false)
    expect(looksLikeFileReference('componentName')).toBe(false)
    expect(looksLikeFileReference('useState')).toBe(false)
  })

  test('未知扩展名（非白名单）', () => {
    // .name/.url/.type/.cn 等看起来像但不是文件扩展名
    expect(looksLikeFileReference('user.name')).toBe(false)
    expect(looksLikeFileReference('config.type')).toBe(false)
    expect(looksLikeFileReference('image.png.typo')).toBe(false)
  })

  test('含空白', () => {
    expect(looksLikeFileReference('foo bar.ts')).toBe(false)
    expect(looksLikeFileReference('src/foo bar.ts')).toBe(false)
    expect(looksLikeFileReference('')).toBe(false)
  })
})

describe('looksLikeFileReference - VS Code 对齐新增场景', () => {
  test('file:/// 协议路径', () => {
    expect(looksLikeFileReference('file:///Users/shawn/foo.ts')).toBe(true)
    expect(looksLikeFileReference('file:///etc/hosts')).toBe(true)
  })

  test('Windows 盘符路径', () => {
    expect(looksLikeFileReference('C:\\Users\\shawn\\foo.ts')).toBe(true)
    expect(looksLikeFileReference('c:/projects/bar/baz.ts')).toBe(true)
    expect(looksLikeFileReference('D:\\code\\app.vue')).toBe(true)
  })
})
