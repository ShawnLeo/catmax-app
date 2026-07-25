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
        } else if (msg.method === 'model/list' && msg.id !== undefined) {
          // startTurn 没传 model 时会走 resolveDefaultModel → model/list
          pushLine(stdout, {
            id: msg.id,
            result: { data: [{ id: 'gpt-5.2-codex', displayName: 'gpt-5.2-codex' }] },
          })
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
        } else if (msg.method === 'model/list' && msg.id !== undefined) {
          // startTurn 没传 model 时会走 resolveDefaultModel → model/list
          pushLine(stdout, {
            id: msg.id,
            result: { data: [{ id: 'gpt-5.2-codex', displayName: 'gpt-5.2-codex' }] },
          })
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
          pushLine(stdout, {
            method: 'item/commandExecution/outputDelta',
            params: {
              itemId: 'cmd_1',
              threadId: 'thr_1',
              turnId: 'codex_turn_1',
              delta: 'file1\n',
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
    pushLine(stdout, {
      method: 'item/fileChange/patchUpdated',
      params: {
        itemId: 'patch_1',
        threadId: 'thr_1',
        turnId: 'codex_turn_1',
        changes: [
          {
            path: '/tmp/a.ts',
            kind: { type: 'update', move_path: null },
            diff: '@@ -1 +1 @@\n-old\n+new',
          },
        ],
      },
    })
    pushLine(stdout, {
      method: 'turn/diff/updated',
      params: {
        threadId: 'thr_1',
        turnId: 'codex_turn_1',
        diff: '--- a/a.ts\n+++ b/a.ts\n-old\n+new',
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
        (e): e is Extract<TurnEvent, { type: 'content_block_upsert' }> =>
          e.type === 'content_block_upsert' &&
          e.block.type === 'codex_activity' &&
          e.block.status === 'running',
      ),
    ).toBe(true)
    expect(
      events.some(
        (e): e is Extract<TurnEvent, { type: 'codex_activity_output_delta' }> =>
          e.type === 'codex_activity_output_delta' && e.text === 'file1\n',
      ),
    ).toBe(true)
    expect(
      events.some(
        (e): e is Extract<TurnEvent, { type: 'content_block_upsert' }> =>
          e.type === 'content_block_upsert' &&
          e.block.type === 'codex_activity' &&
          e.block.activities.some(
            (activity) =>
              activity.kind === 'file_change' &&
              activity.changes[0]?.stats.additions === 1 &&
              activity.changes[0]?.stats.deletions === 1,
          ),
      ),
    ).toBe(true)
    expect(
      events.some(
        (e): e is Extract<TurnEvent, { type: 'codex_turn_diff_updated' }> =>
          e.type === 'codex_turn_diff_updated',
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
        (e): e is Extract<TurnEvent, { type: 'content_block_upsert' }> =>
          e.type === 'content_block_upsert' &&
          e.block.type === 'codex_activity' &&
          e.block.status === 'completed',
      ),
    ).toBe(true)
    expect(events.some((e) => e.type === 'turn_completed')).toBe(true)
  })

  test('listModels 返回模型列表（映射 isDefault / supportedEfforts）', async () => {
    const { spawner, stdout, stdin } = createMockSpawner()
    const adapter = new CodexAdapter({ spawner })

    stdin.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        const msg = JSON.parse(line)
        if (msg.method === 'initialize') {
          pushLine(stdout, { id: msg.id, result: { ok: true } })
        } else if (msg.method === 'model/list' && msg.id !== undefined) {
          // codex 0.93.0 实测响应结构：顶层 data[]，字段 camelCase
          pushLine(stdout, {
            id: msg.id,
            result: {
              data: [
                {
                  id: 'gpt-5.2-codex',
                  model: 'gpt-5.2-codex',
                  displayName: 'gpt-5.2-codex',
                  description: 'Latest frontier agentic coding model.',
                  isDefault: true,
                  defaultReasoningEffort: 'medium',
                  supportedReasoningEfforts: [
                    { reasoningEffort: 'low', description: '...' },
                    { reasoningEffort: 'medium', description: '...' },
                    { reasoningEffort: 'high', description: '...' },
                    { reasoningEffort: 'xhigh', description: '...' }, // 不在 capabilities，应被过滤
                  ],
                },
                {
                  id: 'gpt-5.1-codex-mini',
                  displayName: 'gpt-5.1-codex-mini',
                  supportedReasoningEfforts: [
                    { reasoningEffort: 'low' },
                    { reasoningEffort: 'medium' },
                  ],
                },
              ],
              nextCursor: null,
            },
          })
        }
      }
    })

    const models = await adapter.listModels()
    expect(models).toHaveLength(2)
    expect(models[0]!.id).toBe('gpt-5.2-codex')
    expect(models[0]!.isDefault).toBe(true)
    // supportedReasoningEfforts 只保留 capabilities 子集（low/medium/high）
    expect(models[0]!.supportedEfforts).toEqual(['low', 'medium', 'high'])
    // 第二项没标 isDefault；efforts 也只透传 low/medium
    expect(models[1]!.supportedEfforts).toEqual(['low', 'medium'])
    expect(models[1]!.isDefault).toBeFalsy()
  })

  test('listModels 失败时返回空数组（不再硬编码过时 model id）', async () => {
    const { spawner, stdout, stdin } = createMockSpawner()
    const adapter = new CodexAdapter({ spawner })

    stdin.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        const msg = JSON.parse(line)
        if (msg.method === 'initialize') {
          pushLine(stdout, { id: msg.id, result: { ok: true } })
        } else if (msg.method === 'model/list' && msg.id !== undefined) {
          // 模拟 codex 拒绝（账户未登录 / 网络不通）
          pushLine(stdout, {
            id: msg.id,
            error: { code: -1, message: 'unauthorized' },
          })
        }
      }
    })

    const models = await adapter.listModels()
    expect(models).toEqual([])
  })

  test('listModels 命中缓存（第二次不重新发 model/list）', async () => {
    const { spawner, stdout, stdin } = createMockSpawner()
    const adapter = new CodexAdapter({ spawner })

    let listCallCount = 0
    stdin.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        const msg = JSON.parse(line)
        if (msg.method === 'initialize') {
          pushLine(stdout, { id: msg.id, result: { ok: true } })
        } else if (msg.method === 'model/list' && msg.id !== undefined) {
          listCallCount++
          pushLine(stdout, {
            id: msg.id,
            result: { data: [{ id: 'gpt-5.2-codex', displayName: 'gpt-5.2-codex' }] },
          })
        }
      }
    })

    await adapter.listModels()
    await adapter.listModels()
    await adapter.listModels()
    expect(listCallCount).toBe(1)
  })

  test('invalidateModelsCache 后下次 listModels 重新发 model/list', async () => {
    const { spawner, stdout, stdin } = createMockSpawner()
    const adapter = new CodexAdapter({ spawner })

    let listCallCount = 0
    stdin.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        const msg = JSON.parse(line)
        if (msg.method === 'initialize') {
          pushLine(stdout, { id: msg.id, result: { ok: true } })
        } else if (msg.method === 'model/list' && msg.id !== undefined) {
          listCallCount++
          pushLine(stdout, {
            id: msg.id,
            result: { data: [{ id: 'gpt-5.2-codex', displayName: 'gpt-5.2-codex' }] },
          })
        }
      }
    })

    await adapter.listModels()
    expect(listCallCount).toBe(1)
    // 缓存命中
    await adapter.listModels()
    expect(listCallCount).toBe(1)
    // 清缓存后重新拉
    adapter.invalidateModelsCache()
    await adapter.listModels()
    expect(listCallCount).toBe(2)
  })

  test('listModels 没声明 isDefault 时把第一项标记为默认', async () => {
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
              data: [
                { id: 'gpt-5.2-codex', displayName: 'gpt-5.2-codex' },
                { id: 'gpt-5.1-codex-max', displayName: 'gpt-5.1-codex-max' },
              ],
            },
          })
        }
      }
    })

    const models = await adapter.listModels()
    expect(models[0]!.isDefault).toBe(true)
    expect(models[1]!.isDefault).toBeFalsy()
  })

  test('startTurn 在 args.model 为空时用 listModels 返回的默认模型', async () => {
    const { spawner, stdout, stdin } = createMockSpawner()
    const adapter = new CodexAdapter({ spawner })

    const capturedTurnStart: any[] = []
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
              data: [{ id: 'gpt-5.2-codex', displayName: 'gpt-5.2-codex', isDefault: true }],
            },
          })
        } else if (msg.method === 'turn/start' && msg.id !== undefined) {
          capturedTurnStart.push(msg)
          pushLine(stdout, { id: msg.id, result: { turn: { id: 'turn_1' } } })
          // 推送 turn/started + turn/completed 让 generator 结束
          pushLine(stdout, {
            method: 'turn/started',
            params: { turn: { id: 'turn_1', status: 'running', items: [] } },
          })
          pushLine(stdout, {
            method: 'turn/completed',
            params: { turn: { id: 'turn_1', status: 'completed', items: [] } },
          })
        }
      }
    })

    // 不传 model，应该走 resolveDefaultModel → 'gpt-5.2-codex'
    const events: any[] = []
    for await (const ev of adapter.startTurn({
      sessionId: 'thr_test',
      prompt: 'hi',
    })) {
      events.push(ev)
    }

    expect(capturedTurnStart).toHaveLength(1)
    expect(capturedTurnStart[0]!.params.model).toBe('gpt-5.2-codex')
    expect(events.some((e) => e.type === 'turn_completed')).toBe(true)
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
