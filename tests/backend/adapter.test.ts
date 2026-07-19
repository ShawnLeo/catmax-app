import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { CodexAdapter } from '@main/backend/codex/adapter'
import type { ProcessSpawner, SpawnedProcess } from '@main/backend/process-spawner'
import type { TurnEvent } from '@shared/backend/types'
import { describe, expect, test, vi } from 'vitest'

/** 创建 mock spawner —— 把 stdout 用 PassThrough 模拟，测试代码可以 push JSON 行 */
function createMockSpawner(): {
  spawner: ProcessSpawner
  stdout: PassThrough
  stdin: PassThrough
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stdin: PassThrough
    pid: number
    kill: (sig?: NodeJS.Signals) => void
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(child as any).stdout = stdout
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(child as any).stdin = stdin
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(child as any).pid = 12345
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(child as any).kill = vi.fn()

  const spawner: ProcessSpawner = {
    spawn(): SpawnedProcess {
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        child: child as any,
        write: (data) => stdin.write(data),
        endInput: () => stdin.end(),
        kill: (sig) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ((child as any).kill as (sig?: NodeJS.Signals) => void)(sig),
        pid: 12345,
      }
    },
  }
  return { spawner, stdout, stdin }
}

/** 向 mock stdout 推一行 JSON */
function pushLine(stream: PassThrough, obj: unknown): void {
  stream.write(JSON.stringify(obj) + '\n')
}

async function collectEvents(iter: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const events: TurnEvent[] = []
  for await (const e of iter) {
    events.push(e)
  }
  return events
}

describe('CodexAdapter', () => {
  test('initialize 发 initialize 请求，收到响应后标记 initialized', async () => {
    const { spawner, stdout, stdin } = createMockSpawner()
    const adapter = new CodexAdapter({ spawner })

    // 监听 stdin，收到 initialize 请求时回复
    let lineCount = 0
    stdin.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        const msg = JSON.parse(line)
        if (msg.method === 'initialize' && msg.id !== undefined) {
          // 回复 initialize response
          pushLine(stdout, {
            id: msg.id,
            result: {
              userAgent: 'codex/1.0',
              codexHome: '/tmp',
              platformFamily: 'darwin',
              platformOs: 'macos',
            },
          })
        }
        lineCount++
      }
    })

    await adapter.initialize()
    expect(lineCount).toBeGreaterThanOrEqual(1)
    // 后续 initialize 不再重复
    const lineCountBefore = lineCount
    await adapter.initialize()
    expect(lineCount).toBe(lineCountBefore)
  })

  test('startTurn 收到 text_delta + turn_completed 后结束', async () => {
    const { spawner, stdout, stdin } = createMockSpawner()
    const adapter = new CodexAdapter({ spawner })

    let initialized = false
    stdin.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        const msg = JSON.parse(line)
        if (msg.method === 'initialize') {
          pushLine(stdout, { id: msg.id, result: { ok: true } })
        } else if (msg.method === 'initialized') {
          initialized = true
        } else if (msg.method === 'turn/start' && msg.id !== undefined) {
          // 回复 turn 对象
          pushLine(stdout, { id: msg.id, result: { turn: { id: 'codex_turn_1' } } })
          // 然后推送几个 notifications（同一同步块内写完）
          pushLine(stdout, {
            method: 'turn/started',
            params: { turn: { id: 'codex_turn_1', status: 'in_progress', items: [] } },
          })
          pushLine(stdout, {
            method: 'item/agentMessage/delta',
            params: { itemId: 'msg_1', delta: 'hello' },
          })
          pushLine(stdout, {
            method: 'item/agentMessage/delta',
            params: { itemId: 'msg_1', delta: ' world' },
          })
          pushLine(stdout, {
            method: 'turn/completed',
            params: { turn: { id: 'codex_turn_1', status: 'completed', items: [] } },
          })
        }
      }
    })

    const iter = adapter.startTurn({ sessionId: 'thr_1', prompt: 'hi' })
    const events = await collectEvents(iter)

    expect(initialized).toBe(true)
    expect(events.some((e) => e.type === 'turn_started')).toBe(true)
    expect(
      events
        .filter((e): e is Extract<TurnEvent, { type: 'text_delta' }> => e.type === 'text_delta')
        .map((e) => e.text),
    ).toEqual(['hello', ' world'])
    expect(
      events.some(
        (e): e is Extract<TurnEvent, { type: 'turn_completed' }> =>
          e.type === 'turn_completed' && e.status === 'completed',
      ),
    ).toBe(true)
  })

  test('command tool_call 流程（item/started + approval + item/completed）', async () => {
    const { spawner, stdout, stdin } = createMockSpawner()
    const adapter = new CodexAdapter({ spawner })

    stdin.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        const msg = JSON.parse(line)
        if (msg.method === 'initialize') {
          pushLine(stdout, { id: msg.id, result: { ok: true } })
        } else if (msg.method === 'turn/start' && msg.id !== undefined) {
          pushLine(stdout, { id: msg.id, result: { turn: { id: 'codex_turn_1' } } })
          pushLine(stdout, {
            method: 'turn/started',
            params: { turn: { id: 'codex_turn_1', status: 'in_progress', items: [] } },
          })
          // item/started (command_execution)
          pushLine(stdout, {
            method: 'item/started',
            params: {
              item: {
                type: 'command_execution',
                id: 'cmd_1',
                command: 'ls -la',
                cwd: '/tmp',
                status: 'in_progress',
              },
            },
          })
          // approval 请求（server-request）
          pushLine(stdout, {
            method: 'item/commandExecution/requestApproval',
            id: 50,
            params: {
              itemId: 'cmd_1',
              threadId: 'thr_1',
              turnId: 'codex_turn_1',
              command: 'ls -la',
              cwd: '/tmp',
            },
          })
          // 等 approval 响应后，推 item/completed —— 由 respondApproval 触发后再推
        }
      }
    })

    // 启动 turn
    const iter = adapter.startTurn({ sessionId: 'thr_1', prompt: 'list files' })
    const collectPromise = collectEvents(iter)

    // 等一下让 approval_requested 推到队列
    await new Promise((r) => setTimeout(r, 100))

    // 模拟用户批准（approval server-request 的 id=50 → requestId='50'）
    await adapter.respondApproval({ requestId: '50', action: 'approve' })

    // 等 stdin 上收到响应后，推 item/completed
    await new Promise((r) => setTimeout(r, 50))

    // 推 item/completed（exit 0）
    pushLine(stdout, {
      method: 'item/completed',
      params: {
        item: {
          type: 'command_execution',
          id: 'cmd_1',
          command: 'ls -la',
          status: 'completed',
          exitCode: 0,
          aggregatedOutput: 'file1\nfile2',
          durationMs: 50,
        },
      },
    })
    // 推 turn/completed 结束
    pushLine(stdout, {
      method: 'turn/completed',
      params: { turn: { id: 'codex_turn_1', status: 'completed', items: [] } },
    })

    const events = await collectPromise
    expect(
      events.some(
        (e): e is Extract<TurnEvent, { type: 'tool_call_started' }> =>
          e.type === 'tool_call_started' && e.tool.kind === 'shell_command',
      ),
    ).toBe(true)
    expect(
      events.some(
        (e): e is Extract<TurnEvent, { type: 'approval_requested' }> =>
          e.type === 'approval_requested' && e.request.riskLevel === 'low',
      ),
    ).toBe(true)
    expect(
      events.some(
        (e): e is Extract<TurnEvent, { type: 'tool_call_completed' }> =>
          e.type === 'tool_call_completed' && e.output.ok === true,
      ),
    ).toBe(true)
    expect(events.some((e) => e.type === 'turn_completed')).toBe(true)
  })

  test('listModels 返回模型列表', async () => {
    const { spawner, stdout, stdin } = createMockSpawner()
    const adapter = new CodexAdapter({ spawner })

    stdin.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        const msg = JSON.parse(line)
        if (msg.method === 'initialize') {
          pushLine(stdout, { id: msg.id, result: { ok: true } })
        } else if (msg.method === 'model/list' && msg.id !== undefined) {
          pushLine(stdout, {
            id: msg.id,
            result: {
              models: [
                { id: 'gpt-5.1-codex', display_name: 'GPT-5.1 Codex' },
                { id: 'gpt-5', display_name: 'GPT-5' },
                { id: 'hidden-model', hidden: true }, // 应被过滤
              ],
            },
          })
        }
      }
    })

    const models = await adapter.listModels()
    expect(models).toHaveLength(2)
    expect(models[0]!.id).toBe('gpt-5.1-codex')
  })

  test('getHistory 返回 NormalizedMessage 数组', async () => {
    const { spawner, stdout, stdin } = createMockSpawner()
    const adapter = new CodexAdapter({ spawner })

    stdin.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        const msg = JSON.parse(line)
        if (msg.method === 'initialize') {
          pushLine(stdout, { id: msg.id, result: { ok: true } })
        } else if (msg.method === 'thread/read' && msg.id !== undefined) {
          pushLine(stdout, {
            id: msg.id,
            result: {
              thread: {
                id: 'thr_1',
                turns: [
                  {
                    id: 'turn_1',
                    items: [
                      {
                        type: 'user_message',
                        id: 'u1',
                        content: [{ type: 'text', text: 'hello' }],
                      },
                      { type: 'agent_message', id: 'a1', text: 'world' },
                    ],
                  },
                ],
              },
            },
          })
        }
      }
    })

    const { messages } = await adapter.getHistory('thr_1')
    expect(messages).toHaveLength(2)
    expect(messages[0]!.role).toBe('user')
    expect(messages[1]!.role).toBe('assistant')
    expect(messages[1]!.textBlocks?.[0]?.text).toBe('world')
  })
})
