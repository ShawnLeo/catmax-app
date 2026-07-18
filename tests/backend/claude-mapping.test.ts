import {
  assistantToEvents,
  resultToEvent,
  toolResultToOutput,
  toolUseToInfo,
} from '@main/backend/claude/mapping'
import { describe, expect, test } from 'vitest'

describe('claude toolUseToInfo', () => {
  test('Bash 工具映射为 shell_command', () => {
    const info = toolUseToInfo({
      type: 'tool_use',
      id: 't1',
      name: 'Bash',
      input: { command: 'git status' },
    })
    expect(info.kind).toBe('shell_command')
    expect(info.title).toBe('git status')
    expect(info.detail).toBe('git status')
  })

  test('Edit 工具映射为 file_edit', () => {
    const info = toolUseToInfo({
      type: 'tool_use',
      id: 't2',
      name: 'Edit',
      input: { file_path: '/foo/bar.ts', old_string: 'a', new_string: 'b' },
    })
    expect(info.kind).toBe('file_edit')
    expect(info.title).toContain('/foo/bar.ts')
  })

  test('Read 工具映射为 file_read', () => {
    const info = toolUseToInfo({
      type: 'tool_use',
      id: 't3',
      name: 'Read',
      input: { file_path: '/foo.txt' },
    })
    expect(info.kind).toBe('file_read')
  })

  test('MCP 工具映射为 mcp', () => {
    const info = toolUseToInfo({
      type: 'tool_use',
      id: 't4',
      name: 'mcp__chrome__click',
      input: { selector: '#btn' },
    })
    expect(info.kind).toBe('mcp')
    expect(info.title).toBe('mcp__chrome__click')
  })

  test('未知工具映射为 other', () => {
    const info = toolUseToInfo({
      type: 'tool_use',
      id: 't5',
      name: 'SomeNewTool',
      input: { x: 1 },
    })
    expect(info.kind).toBe('other')
  })
})

describe('claude toolResultToOutput', () => {
  test('成功 + 字符串 content', () => {
    const out = toolResultToOutput({
      type: 'tool_result',
      tool_use_id: 't1',
      content: 'done',
    })
    expect(out.ok).toBe(true)
    expect(out.summary).toBe('completed')
    expect(out.output).toBe('done')
  })

  test('失败', () => {
    const out = toolResultToOutput({
      type: 'tool_result',
      tool_use_id: 't1',
      content: 'error msg',
      is_error: true,
    })
    expect(out.ok).toBe(false)
    expect(out.summary).toBe('failed')
  })

  test('数组 content 拼接', () => {
    const out = toolResultToOutput({
      type: 'tool_result',
      tool_use_id: 't1',
      content: [
        { type: 'text', text: 'line1' },
        { type: 'text', text: 'line2' },
      ],
    })
    expect(out.output).toBe('line1\nline2')
  })
})

describe('claude assistantToEvents', () => {
  test('text 块 → text_delta', () => {
    const events = Array.from(
      assistantToEvents(
        {
          type: 'assistant',
          message: {
            id: 'm1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
          },
        },
        'turn1',
      ),
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'text_delta', text: 'hello', turnId: 'turn1' })
  })

  test('thinking 块 → reasoning_delta', () => {
    const events = Array.from(
      assistantToEvents(
        {
          type: 'assistant',
          message: {
            id: 'm1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'hmm' }],
          },
        },
        'turn1',
      ),
    )
    expect(events[0]).toMatchObject({ type: 'reasoning_delta', text: 'hmm' })
  })

  test('tool_use 块 → tool_call_started', () => {
    const events = Array.from(
      assistantToEvents(
        {
          type: 'assistant',
          message: {
            id: 'm1',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool_1',
                name: 'Bash',
                input: { command: 'ls' },
              },
            ],
          },
        },
        'turn1',
      ),
    )
    expect(events[0]).toMatchObject({
      type: 'tool_call_started',
      itemId: 'tool_1',
      tool: { kind: 'shell_command' },
    })
  })

  test('混合 content 块产生多个事件', () => {
    const events = Array.from(
      assistantToEvents(
        {
          type: 'assistant',
          message: {
            id: 'm1',
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'text', text: 'running' },
              { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
            ],
          },
        },
        'turn1',
      ),
    )
    expect(events).toHaveLength(2)
  })
})

describe('claude resultToEvent', () => {
  test('success → turn_completed', () => {
    const event = resultToEvent(
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        total_cost_usd: 0.001,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      'turn1',
    )
    expect(event.type).toBe('turn_completed')
    expect(event).toHaveProperty('status', 'completed')
    expect(event).toHaveProperty('usage')
  })

  test('error → turn_completed with status=error', () => {
    const event = resultToEvent(
      {
        type: 'result',
        subtype: 'error_max_budget_usd',
        is_error: true,
      },
      'turn1',
    )
    expect(event).toHaveProperty('status', 'error')
  })
})
