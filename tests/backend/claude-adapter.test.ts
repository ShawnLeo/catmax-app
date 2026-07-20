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

  test('result error → error event + turn_completed status=error（Bug D-2）', async () => {
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

    // Bug D-2：必须先 yield error event（带可读 message），让 UI 能显示
    const errorEvent = events.find((e: any) => e.type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as any).message).toContain('budget exceeded')
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

  test('Bug D-1：新会话（startSession 建的）首次 turn 不带 --resume', async () => {
    const { spawner, stdout } = createMockSpawner()
    const spawnSpy = vi.spyOn(spawner, 'spawn')
    const adapter = new ClaudeAdapter({ spawner })

    // 模拟 ChatView 流程：先 startSession 拿到 backendThreadId，再 startTurn
    const { backendThreadId } = await adapter.startSession({ cwd: '/tmp' })

    setTimeout(() => {
      pushClaudeLine(stdout, {
        type: 'system',
        subtype: 'init',
        session_id: 'real-claude-sess-id',
      })
      pushClaudeLine(stdout, {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
        },
      })
      pushClaudeLine(stdout, { type: 'result', subtype: 'success', is_error: false })
    }, 10)

    const events: unknown[] = []
    for await (const e of adapter.startTurn({ sessionId: backendThreadId, prompt: 'hi' })) {
      events.push(e)
    }

    // 关键断言：spawn 调用一次，且 args 数组里不能有 '--resume'
    expect(spawnSpy).toHaveBeenCalledTimes(1)
    const spawnArgs = spawnSpy.mock.calls[0]?.[0]?.args as string[]
    expect(spawnArgs).toBeDefined()
    expect(spawnArgs).not.toContain('--resume')
  })

  test('Bug D-1：第二次 turn 应该带 --resume <真实 session_id>', async () => {
    // 用一个 per-spawn-call 的 mock：每次 spawn 返回新的 stdout/stdin pair。
    // 这样两次 turn（claude 是 per-turn 进程模型）都能各自 write。
    const spawnCalls: { stdout: PassThrough; stdin: PassThrough; child: EventEmitter }[] = []
    const spawner: ProcessSpawner = {
      spawn() {
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
        const entry = { stdout, stdin, child }
        spawnCalls.push(entry)
        return {
          child: child as any,
          write: (data) => stdin.write(data),
          endInput: () => stdin.end(),
          kill: (sig) => (child as any).kill(sig),
          pid: 12345,
        }
      },
    }
    const spawnSpy = vi.spyOn(spawner, 'spawn')
    const adapter = new ClaudeAdapter({ spawner })

    const { backendThreadId } = await adapter.startSession({ cwd: '/tmp' })

    // 第一次 turn —— 等到 spawn 发生后注入 system.init + result
    setTimeout(() => {
      const first = spawnCalls[0]
      if (!first) return
      pushClaudeLine(first.stdout, {
        type: 'system',
        subtype: 'init',
        session_id: 'real-claude-sess-id',
      })
      pushClaudeLine(first.stdout, { type: 'result', subtype: 'success', is_error: false })
    }, 10)
    for await (const _e of adapter.startTurn({ sessionId: backendThreadId, prompt: 'hi' })) {
      void _e
    }

    // 第二次 turn —— 同样等 spawn 后注入
    setTimeout(() => {
      const second = spawnCalls[1]
      if (!second) return
      pushClaudeLine(second.stdout, {
        type: 'system',
        subtype: 'init',
        session_id: 'real-claude-sess-id',
      })
      pushClaudeLine(second.stdout, { type: 'result', subtype: 'success', is_error: false })
    }, 10)
    for await (const _e of adapter.startTurn({ sessionId: backendThreadId, prompt: 'again' })) {
      void _e
    }

    // 总共 spawn 两次
    expect(spawnSpy).toHaveBeenCalledTimes(2)
    // 第二次 spawn 必须带 --resume real-claude-sess-id
    const secondSpawnArgs = spawnSpy.mock.calls[1]?.[0]?.args as string[]
    expect(secondSpawnArgs).toContain('--resume')
    const resumeIdx = secondSpawnArgs.indexOf('--resume')
    expect(secondSpawnArgs[resumeIdx + 1]).toBe('real-claude-sess-id')
    // 第一次 spawn 不能带 --resume
    const firstSpawnArgs = spawnSpy.mock.calls[0]?.[0]?.args as string[]
    expect(firstSpawnArgs).not.toContain('--resume')
  })

  test('Bug E-1：startTurn 用 args.cwd 作为 spawn cwd（不再用 adapter opts.cwd）', async () => {
    const { spawner, stdout } = createMockSpawner()
    const spawnSpy = vi.spyOn(spawner, 'spawn')
    // adapter opts.cwd 也设了，但 args.cwd 应该优先
    const adapter = new ClaudeAdapter({ spawner, cwd: '/from-opts' })

    setTimeout(() => {
      pushClaudeLine(stdout, { type: 'system', subtype: 'init', session_id: 's1' })
      pushClaudeLine(stdout, { type: 'result', subtype: 'success', is_error: false })
    }, 10)

    for await (const _e of adapter.startTurn({
      sessionId: 'sess-1',
      prompt: 'hi',
      cwd: '/from-args',
    })) {
      void _e
    }

    expect(spawnSpy).toHaveBeenCalledTimes(1)
    expect(spawnSpy.mock.calls[0]?.[0]?.cwd).toBe('/from-args')
  })

  test('Bug E-1：startTurn 不传 args.cwd 时回落到 adapter opts.cwd', async () => {
    const { spawner, stdout } = createMockSpawner()
    const spawnSpy = vi.spyOn(spawner, 'spawn')
    const adapter = new ClaudeAdapter({ spawner, cwd: '/from-opts' })

    setTimeout(() => {
      pushClaudeLine(stdout, { type: 'system', subtype: 'init', session_id: 's1' })
      pushClaudeLine(stdout, { type: 'result', subtype: 'success', is_error: false })
    }, 10)

    for await (const _e of adapter.startTurn({ sessionId: 'sess-1', prompt: 'hi' })) {
      void _e
    }

    expect(spawnSpy.mock.calls[0]?.[0]?.cwd).toBe('/from-opts')
  })

  // 注：getHistory 的测试见 tests/backend/claude-jsonl-reader.test.ts
  // （getHistory 改为直接读 jsonl 文件后不再用 spawner）
})
