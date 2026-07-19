import { claudeReplayToMessages } from '@main/backend/claude/history-mapping'
import { describe, expect, test } from 'vitest'

describe('claude history mapping', () => {
  test('assistant + user 文本转消息', () => {
    const messages = claudeReplayToMessages([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
        },
      },
    ])
    expect(messages).toHaveLength(2)
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.textBlocks?.[0]?.text).toBe('hi')
    expect(messages[1]!.role).toBe('assistant')
    expect(messages[1]!.textBlocks?.[0]?.text).toBe('hello')
  })

  test('tool_use + tool_result 配对', () => {
    const messages = claudeReplayToMessages([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'text', text: 'running' },
            { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file1' }],
        },
      },
    ])
    expect(messages).toHaveLength(1) // assistant 含 tool
    expect(messages[0]!.toolBlocks?.[0]?.status).toBe('completed')
    expect(messages[0]!.toolBlocks?.[0]?.output?.output).toBe('file1')
  })

  test('未配对的 tool_use 标为 completed（带默认 output）', () => {
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
    ])
    expect(messages[0]!.toolBlocks?.[0]?.status).toBe('completed')
    expect(messages[0]!.toolBlocks?.[0]?.output?.summary).toContain('no result')
  })

  test('thinking 块归 reasoning', () => {
    const messages = claudeReplayToMessages([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm let me think' },
            { type: 'text', text: 'answer' },
          ],
        },
      },
    ])
    expect(messages[0]!.textBlocks).toHaveLength(2)
    expect(messages[0]!.textBlocks?.[0]?.kind).toBe('reasoning')
    expect(messages[0]!.textBlocks?.[1]?.kind).toBe('text')
  })

  test('空输入返回空数组', () => {
    expect(claudeReplayToMessages([])).toEqual([])
  })

  test('system + result 消息被忽略', () => {
    const messages = claudeReplayToMessages([
      { type: 'system', subtype: 'init', session_id: 's1' },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
        },
      },
      { type: 'result', subtype: 'success', is_error: false },
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('assistant')
  })
})
