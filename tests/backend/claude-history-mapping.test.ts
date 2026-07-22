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

  test('slash command 调用合并：sentinel + 展开文本只展示 command-name', () => {
    // claude 写 jsonl 时 slash command 会写两条 user 消息：
    //   1. sentinel 文本（<command-message>X</command-message><command-name>/X</command-name>）
    //   2. claude 自己注入的长 prompt 展开（isMeta:true）让 agent 知道怎么执行
    // UI 上只展示一条（command-name "/init"），长 prompt 隐藏。
    const messages = claudeReplayToMessages([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<command-message>init</command-message>\n<command-name>/init</command-name>',
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Please analyze this codebase and create a CLAUDE.md file, which will be given to future instances of Claude Code to operate in this repository.\n\nWhat to add:\n1. Commands that will be commonly used...',
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        },
      },
    ])
    // 只展示一条 user 消息（sentinel 解析后的 "/init"），展开 prompt 被跳过
    const userMsgs = messages.filter((m) => m.role === 'user')
    expect(userMsgs).toHaveLength(1)
    expect(userMsgs[0]!.textBlocks?.[0]?.text).toBe('/init')
  })

  test('slash command 后跟 assistant，flag 不误清', () => {
    // 边界：command sentinel 后没有展开 prompt，直接是 assistant 回复——
    // 这种情况下 command 调用本身应正常展示，不会被跳过
    const messages = claudeReplayToMessages([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<command-message>clear</command-message>\n<command-name>/clear</command-name>',
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'cleared' }],
        },
      },
    ])
    expect(messages).toHaveLength(2)
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.textBlocks?.[0]?.text).toBe('/clear')
    expect(messages[1]!.role).toBe('assistant')
  })
})
