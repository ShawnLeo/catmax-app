import {
  assistantMessageSchema,
  claudeStreamMessageSchema,
  resultMessageSchema,
  systemMessageSchema,
} from '@shared/backend/claude-schema'
import { describe, expect, test } from 'vitest'

describe('claude stream-json schema', () => {
  test('system init 消息解析', () => {
    const msg = {
      type: 'system',
      subtype: 'init',
      cwd: '/tmp',
      session_id: 'abc-123',
      model: 'claude-sonnet-4-6',
      permissionMode: 'default',
    }
    expect(systemMessageSchema.safeParse(msg).success).toBe(true)
  })

  test('assistant text 消息解析', () => {
    const msg = {
      type: 'assistant',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
      },
    }
    expect(assistantMessageSchema.safeParse(msg).success).toBe(true)
  })

  test('assistant tool_use 消息解析', () => {
    const msg = {
      type: 'assistant',
      message: {
        id: 'msg_2',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'Bash',
            input: { command: 'ls -la' },
          },
        ],
      },
    }
    expect(assistantMessageSchema.safeParse(msg).success).toBe(true)
  })

  test('assistant thinking 消息解析', () => {
    const msg = {
      type: 'assistant',
      message: {
        id: 'msg_3',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'let me think...' }],
      },
    }
    expect(assistantMessageSchema.safeParse(msg).success).toBe(true)
  })

  test('result success 消息解析', () => {
    const msg = {
      type: 'result',
      subtype: 'success',
      duration_ms: 1500,
      is_error: false,
      num_turns: 1,
      result: '4',
      session_id: 'abc-123',
      total_cost_usd: 0.001,
      usage: { input_tokens: 10, output_tokens: 5 },
    }
    expect(resultMessageSchema.safeParse(msg).success).toBe(true)
  })

  test('result error 消息解析', () => {
    const msg = {
      type: 'result',
      subtype: 'error_max_budget_usd',
      is_error: true,
      errors: ['Reached maximum budget ($0.05)'],
    }
    expect(resultMessageSchema.safeParse(msg).success).toBe(true)
  })

  test('未知 content block 用 passthrough 接住', () => {
    const msg = {
      type: 'assistant',
      message: {
        id: 'msg_x',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'some_future_block', custom: 'data' }],
      },
    }
    expect(assistantMessageSchema.safeParse(msg).success).toBe(true)
  })

  test('顶层联合消息分发', () => {
    const system = { type: 'system', subtype: 'init' }
    const assistant = {
      type: 'assistant',
      message: { id: 'm', type: 'message', role: 'assistant', content: [] },
    }
    const result = { type: 'result', subtype: 'success', is_error: false }

    expect(claudeStreamMessageSchema.safeParse(system).success).toBe(true)
    expect(claudeStreamMessageSchema.safeParse(assistant).success).toBe(true)
    expect(claudeStreamMessageSchema.safeParse(result).success).toBe(true)
  })
})
