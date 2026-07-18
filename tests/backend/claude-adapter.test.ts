import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { ClaudeAdapter } from '@main/backend/claude/adapter'
import type { ProcessSpawner, SpawnedProcess } from '@main/backend/process-spawner'
import { describe, expect, test, vi } from 'vitest'

function createMockSpawner(): { spawner: ProcessSpawner; stdout: PassThrough; stdin: PassThrough } {
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stdin: PassThrough
    pid: number
    kill: (sig?: NodeJS.Signals) => void
  }
  ;(child as any).stdout = stdout
  ;(child as any).stdin = stdin
  ;(child as any).pid = 12345
  ;(child as any).kill = vi.fn()

  const spawner: ProcessSpawner = {
    spawn(): SpawnedProcess {
      return {
        child: child as any,
        write: (data) => stdin.write(data),
        endInput: () => stdin.end(),
        kill: (sig) => (child as any).kill(sig),
        pid: 12345,
      }
    },
  }
  return { spawner, stdout, stdin }
}

function pushClaudeLine(stream: PassThrough, obj: unknown): void {
  stream.write(JSON.stringify(obj) + '\n')
}

describe('ClaudeAdapter', () => {
  test('startTurn 流式 text + 完成', async () => {
    const { spawner, stdout } = createMockSpawner()
    const adapter = new ClaudeAdapter({ spawner })

    // spawn 后立即推消息（claude 启动很快）
    setTimeout(() => {
      pushClaudeLine(stdout, {
        type: 'system',
        subtype: 'init',
        session_id: 'claude-sess-1',
      })
      pushClaudeLine(stdout, {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
        },
      })
      pushClaudeLine(stdout, {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'hello',
      })
    }, 10)

    const events: unknown[] = []
    for await (const e of adapter.startTurn({ sessionId: 'sess-1', prompt: 'hi' })) {
      events.push(e)
    }

    expect(events.some((e: any) => e.type === 'turn_started')).toBe(true)
    expect(events.some((e: any) => e.type === 'text_delta' && e.text === 'hello')).toBe(true)
    expect(events.some((e: any) => e.type === 'turn_completed' && e.status === 'completed')).toBe(
      true,
    )
  })

  test('tool_use + tool_result 流程', async () => {
    const { spawner, stdout } = createMockSpawner()
    const adapter = new ClaudeAdapter({ spawner })

    setTimeout(() => {
      pushClaudeLine(stdout, { type: 'system', subtype: 'init', session_id: 's1' })
      // assistant: tool_use
      pushClaudeLine(stdout, {
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
      })
      // user: tool_result
      pushClaudeLine(stdout, {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: 'file1\nfile2',
            },
          ],
        },
      })
      // assistant: 最终回复
      pushClaudeLine(stdout, {
        type: 'assistant',
        message: {
          id: 'm2',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        },
      })
      pushClaudeLine(stdout, {
        type: 'result',
        subtype: 'success',
        is_error: false,
      })
    }, 10)

    const events: unknown[] = []
    for await (const e of adapter.startTurn({ sessionId: 'sess-1', prompt: 'list files' })) {
      events.push(e)
    }

    expect(
      events.some((e: any) => e.type === 'tool_call_started' && e.tool.kind === 'shell_command'),
    ).toBe(true)
    expect(events.some((e: any) => e.type === 'tool_call_completed' && e.output.ok === true)).toBe(
      true,
    )
    expect(events.some((e: any) => e.type === 'turn_completed')).toBe(true)
  })

  test('result error → turn_completed status=error', async () => {
    const { spawner, stdout } = createMockSpawner()
    const adapter = new ClaudeAdapter({ spawner })

    setTimeout(() => {
      pushClaudeLine(stdout, { type: 'system', subtype: 'init', session_id: 's1' })
      pushClaudeLine(stdout, {
        type: 'result',
        subtype: 'error_max_budget_usd',
        is_error: true,
        errors: ['budget exceeded'],
      })
    }, 10)

    const events: unknown[] = []
    for await (const e of adapter.startTurn({ sessionId: 'sess-1', prompt: 'hi' })) {
      events.push(e)
    }

    expect(events.some((e: any) => e.type === 'turn_completed' && e.status === 'error')).toBe(true)
  })

  test('capabilities: 不支持 approval/steer/fork', () => {
    const adapter = new ClaudeAdapter()
    expect(adapter.capabilities.supportsApproval).toBe(false)
    expect(adapter.capabilities.supportsSteer).toBe(false)
    expect(adapter.capabilities.supportsThreadFork).toBe(false)
    expect(adapter.capabilities.supportedEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  test('listModels 返回固定列表', async () => {
    const adapter = new ClaudeAdapter()
    const models = await adapter.listModels()
    expect(models.length).toBeGreaterThanOrEqual(2)
    expect(models.some((m) => m.isDefault)).toBe(true)
  })
})
