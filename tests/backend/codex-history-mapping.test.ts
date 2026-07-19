import {
  codexTurnsToMessages,
  mergeAssistantAndToolMessages,
} from '@main/backend/codex/history-mapping'
import type { NormalizedMessage } from '@shared/backend/types'
import { describe, expect, test } from 'vitest'

describe('codex history mapping', () => {
  test('user_message + agent_message 转 user/assistant', () => {
    const turns = [
      {
        id: 'turn_1',
        items: [
          { type: 'user_message', id: 'u1', content: [{ type: 'text', text: 'hello' }] },
          { type: 'agent_message', id: 'a1', text: 'hi there' },
        ],
      },
    ]
    const messages = codexTurnsToMessages(turns)
    expect(messages).toHaveLength(2)
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.textBlocks?.[0]?.text).toBe('hello')
    expect(messages[1]!.role).toBe('assistant')
    expect(messages[1]!.textBlocks?.[0]?.text).toBe('hi there')
  })

  test('command_execution 转为 tool message', () => {
    const turns = [
      {
        id: 'turn_1',
        items: [
          { type: 'user_message', id: 'u1', content: 'list files' },
          { type: 'agent_message', id: 'a1', text: '' },
          {
            type: 'command_execution',
            id: 'c1',
            command: 'ls',
            status: 'completed',
            exitCode: 0,
            aggregatedOutput: 'file1\nfile2',
          },
        ],
      },
    ]
    const messages = codexTurnsToMessages(turns)
    // user + assistant（空文本）+ tool
    expect(messages.some((m) => m.role === 'tool')).toBe(true)
    const tool = messages.find((m) => m.role === 'tool')!
    expect(tool.toolBlocks?.[0]?.info.kind).toBe('shell_command')
  })

  test('mergeAssistantAndToolMessages 把 tool 合并到 assistant', () => {
    const messages: NormalizedMessage[] = [
      { id: 'u1', role: 'user', turnId: 't1', textBlocks: [], createdAt: 0 },
      {
        id: 'a1',
        role: 'assistant',
        turnId: 't1',
        textBlocks: [],
        toolBlocks: [],
        createdAt: 0,
      },
      {
        id: 'c1',
        role: 'tool',
        turnId: 't1',
        textBlocks: [],
        toolBlocks: [
          {
            id: 'c1',
            info: { kind: 'shell_command', title: 'ls' },
            status: 'completed',
          },
        ],
        createdAt: 0,
      },
    ]
    const merged = mergeAssistantAndToolMessages(messages)
    expect(merged).toHaveLength(2) // user + assistant（含 tool）
    expect(merged[1]!.toolBlocks).toHaveLength(1)
  })

  test('空 turns 返回空数组', () => {
    expect(codexTurnsToMessages([])).toEqual([])
  })

  test('未知 item 类型跳过', () => {
    const turns = [
      {
        id: 't1',
        items: [
          { type: 'unknown_future_type', id: 'x1', customField: 'whatever' },
          { type: 'agent_message', id: 'a1', text: 'kept' },
        ],
      },
    ]
    const messages = codexTurnsToMessages(turns)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.textBlocks?.[0]?.text).toBe('kept')
  })

  test('reasoning + agent_message 合并到同一个 assistant', () => {
    const turns = [
      {
        id: 't1',
        items: [
          {
            type: 'reasoning',
            id: 'r1',
            summary: [{ type: 'summary_text', text: 'thinking...' }],
          },
          { type: 'agent_message', id: 'a1', text: 'answer' },
        ],
      },
    ]
    const messages = codexTurnsToMessages(turns)
    // reasoning 先成为 assistant，agent_message 再 flush reasoning + 自成 assistant
    expect(messages).toHaveLength(2)
    expect(messages[0]!.textBlocks?.[0]?.kind).toBe('reasoning')
    expect(messages[1]!.textBlocks?.[0]?.text).toBe('answer')
  })
})
