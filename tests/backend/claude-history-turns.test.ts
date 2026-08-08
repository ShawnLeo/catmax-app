import { claudeReplayToMessages } from '@main/backend/claude/history-mapping'
import type { ToolCallContentBlock } from '@shared/backend/blocks'
import { describe, expect, test } from 'vitest'

/**
 * 历史回放要还原出与实时流同构的结构：真实轮次、真实时间、与到达顺序一致的块序。
 * 这三样过去都是丢的（turnId 恒为 'history'、createdAt 恒为 0、块序被重排），
 * 结果是同一段对话"刚跑完"和"重新打开"看起来不是一回事。
 */
describe('claude 历史回放 · 轮次与时间还原', () => {
  test('每次真实用户输入开启新一轮，其后的 assistant 归入该轮', () => {
    const messages = claudeReplayToMessages([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '第一个问题' }] },
      },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'A' }],
        },
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '第二个问题' }] },
      },
      {
        type: 'assistant',
        message: {
          id: 'm2',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'B' }],
        },
      },
    ])

    const turnIds = messages.map((m) => m.turnId)
    expect(turnIds[0]).toBe(turnIds[1])
    expect(turnIds[2]).toBe(turnIds[3])
    expect(turnIds[0]).not.toBe(turnIds[2])
    // 整个会话不再塌成一轮——时间轴与每轮改动卡片都依赖这个边界
    expect(new Set(turnIds).size).toBe(2)
  })

  test('tool_result 不算新一轮', () => {
    const messages = claudeReplayToMessages([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '跑一下' }] },
      },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }],
        },
      },
      {
        type: 'assistant',
        message: {
          id: 'm2',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: '完成' }],
        },
      },
    ])

    expect(new Set(messages.map((m) => m.turnId)).size).toBe(1)
  })

  test('createdAt 取 jsonl 的 ISO timestamp', () => {
    const messages = claudeReplayToMessages([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        timestamp: '2026-08-05T13:39:04.916Z',
      },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'yo' }],
        },
        timestamp: '2026-08-05T13:39:07.000Z',
      },
    ])

    expect(messages[0]!.createdAt).toBe(Date.parse('2026-08-05T13:39:04.916Z'))
    expect(messages[1]!.createdAt).toBe(Date.parse('2026-08-05T13:39:07.000Z'))
  })

  test('没有 timestamp 时回落到 0，不产生 NaN', () => {
    const messages = claudeReplayToMessages([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'x' }],
        },
      },
    ])
    expect(messages[0]!.createdAt).toBe(0)
  })
})

describe('claude 历史回放 · 块顺序', () => {
  test('blocks 按 content 原顺序，不把工具排到正文前面', () => {
    const messages = claudeReplayToMessages([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '想一下' },
            { type: 'text', text: '我来读文件' },
            { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a.txt' } },
          ],
        },
      },
    ])

    expect(messages[0]!.blocks?.map((b) => b.type)).toEqual(['reasoning', 'text', 'tool_call'])
  })

  test('tool_result 回填同时反映在 blocks 上（共享同一个对象）', () => {
    const messages = claudeReplayToMessages([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'a.txt' }],
        },
      },
    ])

    const block = messages[0]!.blocks?.find((b) => b.type === 'tool_call') as
      ToolCallContentBlock | undefined
    expect(block?.status).toBe('completed')
    expect(block?.output?.ok).toBe(true)
  })
})
