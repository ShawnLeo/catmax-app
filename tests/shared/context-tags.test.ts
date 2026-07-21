/**
 * context-tags.ts 提取 / 序列化纯函数测试。
 *
 * 核心契约：serializeContextTags 跟 extractContextTags 必须往返一致——
 * 实时发送时 serialize，落到 jsonl 后历史回放 extract，必须能还原出同样的 contextBlocks。
 */
import { describe, expect, test } from 'vitest'

import { sharedContextTagExtractors } from '../../src/shared/backend/context-tag-handlers'
import type { ContextBlock } from '../../src/shared/backend/context-tag-types'
import { extractContextTags, serializeContextTags } from '../../src/shared/backend/context-tags'

const IDE_SELECTION_EXAMPLE = `<ide_selection>The user selected the lines 76 to 82 from /Users/shawn/code/app/src/lib/foo.ts:
const x = 1
const y = 2
This may or may not be related to the current task.</ide_selection>`

const IDE_OPENED_FILE_EXAMPLE = `<ide_opened_file>The user opened the file /Users/shawn/code/app/src/lib/bar.vue in the IDE. This may or may not be related to the current task.</ide_opened_file>`

const ENVIRONMENT_CONTEXT_EXAMPLE = `<environment_context>
<cwd>/Users/shawn/code/app</cwd>
<shell>zsh</shell>
<model>gpt-5.1-codex</model>
</environment_context>`

describe('extractContextTags', () => {
  test('提取 ide_selection', () => {
    const { text, blocks } = extractContextTags(
      `看一下这段代码\n${IDE_SELECTION_EXAMPLE}`,
      sharedContextTagExtractors,
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.tag).toBe('ide_selection')
    const data = blocks[0]!.data as {
      filePath: string
      startLine: number
      endLine: number
      code: string
    }
    expect(data.filePath).toBe('/Users/shawn/code/app/src/lib/foo.ts')
    expect(data.startLine).toBe(76)
    expect(data.endLine).toBe(82)
    expect(data.code).toBe('const x = 1\nconst y = 2')
    // 提取后原文不留 tag
    expect(text).toBe('看一下这段代码')
  })

  test('提取 ide_opened_file', () => {
    const { text, blocks } = extractContextTags(IDE_OPENED_FILE_EXAMPLE, sharedContextTagExtractors)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.tag).toBe('ide_opened_file')
    const data = blocks[0]!.data as { filePath: string }
    expect(data.filePath).toBe('/Users/shawn/code/app/src/lib/bar.vue')
    expect(text).toBe('')
  })

  test('提取 environment_context（codex 注入）', () => {
    const { text, blocks } = extractContextTags(
      `${ENVIRONMENT_CONTEXT_EXAMPLE}\n帮我看看 cwd 里的项目结构`,
      sharedContextTagExtractors,
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.tag).toBe('environment_context')
    const data = blocks[0]!.data as { raw: string }
    expect(data.raw).toContain('<cwd>/Users/shawn/code/app</cwd>')
    expect(data.raw).toContain('<shell>zsh</shell>')
    // 提取后只剩用户 prompt
    expect(text).toBe('帮我看看 cwd 里的项目结构')
  })

  test('无 tag 时返回原文本 + 空 blocks', () => {
    const text = '普通文本，没有任何 tag'
    const result = extractContextTags(text, sharedContextTagExtractors)
    expect(result.text).toBe(text)
    expect(result.blocks).toEqual([])
  })

  test('空文本', () => {
    const result = extractContextTags('', sharedContextTagExtractors)
    expect(result.text).toBe('')
    expect(result.blocks).toEqual([])
  })

  test('残破的 tag（不闭合）原样保留不报错', () => {
    const broken = '<ide_selection>没闭合的 tag'
    const result = extractContextTags(broken, sharedContextTagExtractors)
    expect(result.text).toBe(broken)
    expect(result.blocks).toEqual([])
  })

  test('多个 tag 混合提取，按位置排序', () => {
    const text = `开头${IDE_OPENED_FILE_EXAMPLE}中间${IDE_SELECTION_EXAMPLE}结尾`
    const { blocks } = extractContextTags(text, sharedContextTagExtractors)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.tag).toBe('ide_opened_file')
    expect(blocks[1]!.tag).toBe('ide_selection')
  })

  test('单行 ide_selection（line 5）', () => {
    const single = `<ide_selection>The user selected the line 5 from /app/foo.py:
x = 1
This may or may not be related to the current task.</ide_selection>`
    const { blocks } = extractContextTags(single, sharedContextTagExtractors)
    expect(blocks).toHaveLength(1)
    const data = blocks[0]!.data as { startLine: number; endLine: number; code: string }
    expect(data.startLine).toBe(5)
    expect(data.endLine).toBe(5)
    expect(data.code).toBe('x = 1')
  })
})

describe('serializeContextTags（往返一致性）', () => {
  test('serialize ide_selection 后能被 extract 还原', () => {
    const prompt = '帮我修一下'
    const blocks: ContextBlock[] = [
      {
        tag: 'ide_selection',
        data: {
          filePath: '/app/foo.ts',
          startLine: 10,
          endLine: 12,
          code: 'const a = 1\nconst b = 2\nconst c = 3',
        },
      },
    ]
    const serialized = serializeContextTags(prompt, blocks)
    // 序列化结果应该包含 prompt 和 tag
    expect(serialized).toContain(prompt)
    expect(serialized).toContain('<ide_selection>')

    // 反向解析应该还原出同样的 data
    const { text, blocks: extracted } = extractContextTags(serialized, sharedContextTagExtractors)
    expect(text).toBe(prompt)
    expect(extracted).toHaveLength(1)
    expect(extracted[0]!.tag).toBe('ide_selection')
    const d = extracted[0]!.data as {
      filePath: string
      startLine: number
      endLine: number
      code: string
    }
    expect(d.filePath).toBe('/app/foo.ts')
    expect(d.startLine).toBe(10)
    expect(d.endLine).toBe(12)
    expect(d.code).toBe('const a = 1\nconst b = 2\nconst c = 3')
  })

  test('serialize ide_opened_file 后能被 extract 还原', () => {
    const prompt = '这个文件怎么用'
    const blocks: ContextBlock[] = [{ tag: 'ide_opened_file', data: { filePath: '/app/bar.vue' } }]
    const serialized = serializeContextTags(prompt, blocks)
    const { text, blocks: extracted } = extractContextTags(serialized, sharedContextTagExtractors)
    expect(text).toBe(prompt)
    expect(extracted).toHaveLength(1)
    expect((extracted[0]!.data as { filePath: string }).filePath).toBe('/app/bar.vue')
  })

  test('空 attachments 时 serialize 原样返回 prompt', () => {
    expect(serializeContextTags('hello', [])).toBe('hello')
  })

  test('多个 attachments 一起 serialize 后 extract 按序还原', () => {
    const prompt = '看下这俩'
    const blocks: ContextBlock[] = [
      { tag: 'ide_opened_file', data: { filePath: '/a.ts' } },
      {
        tag: 'ide_selection',
        data: { filePath: '/b.ts', startLine: 1, endLine: 2, code: 'x\ny' },
      },
    ]
    const serialized = serializeContextTags(prompt, blocks)
    const { blocks: extracted } = extractContextTags(serialized, sharedContextTagExtractors)
    expect(extracted).toHaveLength(2)
    expect(extracted[0]!.tag).toBe('ide_opened_file')
    expect(extracted[1]!.tag).toBe('ide_selection')
  })
})
