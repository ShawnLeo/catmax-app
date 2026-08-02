import { describe, expect, it } from 'vitest'

import {
  appendFileMention,
  formatFileMention,
  hasFileMention,
  parseFileMentions,
  removeFileMentionAt,
  segmentFileMentions,
} from './file-mention'

describe('parseFileMentions', () => {
  it('抓出行首和空白之后的 @路径', () => {
    const text = '看看 @src/a.ts 和 @src/b.ts'
    expect(parseFileMentions(text).map((m) => m.path)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('offset 精确指向 token 本身，不含前导空白', () => {
    const text = 'x @a.ts'
    const [m] = parseFileMentions(text)
    expect(text.slice(m!.start, m!.end)).toBe('@a.ts')
  })

  it('引号包裹的路径可以含空格', () => {
    expect(parseFileMentions('@"~/Desktop/My File.txt"').map((m) => m.path)).toEqual([
      '~/Desktop/My File.txt',
    ])
  })

  // 没有这条约束，邮箱和 scp 风格的地址都会被当成文件引用
  it('不把词中间的 @ 当引用', () => {
    expect(parseFileMentions('联系 foo@bar.com')).toEqual([])
    expect(parseFileMentions('user@host:/tmp/x')).toEqual([])
  })

  it('行首的 @ 算引用', () => {
    expect(parseFileMentions('@a.ts 改一下').map((m) => m.path)).toEqual(['a.ts'])
  })
})

describe('formatFileMention', () => {
  it('含空格的路径必须加引号，否则回读时被空白截断', () => {
    expect(formatFileMention('a b.txt')).toBe('@"a b.txt"')
    expect(formatFileMention('a.txt')).toBe('@a.txt')
  })

  it('format 出来的 token 能被 parse 原样读回', () => {
    for (const path of ['src/a.ts', '~/My Docs/b.md', '/tmp/c d.txt']) {
      expect(parseFileMentions(formatFileMention(path))[0]?.path).toBe(path)
    }
  })
})

describe('appendFileMention', () => {
  it('空文本直接插入', () => {
    expect(appendFileMention('', 'a.ts')).toBe('@a.ts ')
  })

  it('已有文本时补一个分隔空格', () => {
    expect(appendFileMention('改一下', 'a.ts')).toBe('改一下 @a.ts ')
    expect(appendFileMention('改一下 ', 'a.ts')).toBe('改一下 @a.ts ')
  })

  it('重复引用同一路径时原样返回', () => {
    const once = appendFileMention('', 'a.ts')
    expect(appendFileMention(once, 'a.ts')).toBe(once)
  })
})

describe('removeFileMentionAt', () => {
  it('删掉 token 并吞掉它自己加的那个空格', () => {
    const text = '改一下 @a.ts 谢谢'
    const [m] = parseFileMentions(text)
    expect(removeFileMentionAt(text, m!)).toBe('改一下 谢谢')
  })

  it('多条引用时只删中间那条', () => {
    const text = '@a.ts @b.ts @c.ts'
    const mentions = parseFileMentions(text)
    expect(removeFileMentionAt(text, mentions[1]!)).toBe('@a.ts @c.ts')
  })
})

describe('hasFileMention', () => {
  it('按路径判断，不看 token 写法', () => {
    expect(hasFileMention('@"a b.txt"', 'a b.txt')).toBe(true)
    expect(hasFileMention('@a.ts', 'b.ts')).toBe(false)
  })
})

describe('segmentFileMentions', () => {
  // 高亮层逐字符复刻 textarea，片段拼不回原文就会错位
  it('切片拼回去必须等于原文', () => {
    for (const text of ['', 'abc', '看 @a.ts 和 @"b c.ts" 结束', '@a.ts', '  @a.ts  ']) {
      expect(
        segmentFileMentions(text)
          .map((s) => s.text)
          .join(''),
      ).toBe(text)
    }
  })

  it('标出哪些片段是引用', () => {
    const segs = segmentFileMentions('看 @a.ts 吧')
    expect(segs.map((s) => [s.text, s.mention !== null])).toEqual([
      ['看 ', false],
      ['@a.ts', true],
      [' 吧', false],
    ])
  })
})
