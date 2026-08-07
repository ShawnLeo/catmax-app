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
            method: 'item/started',
            params: {
              item: {
                type: 'agentMessage',
                id: 'msg_1',
                text: '',
                phase: null,
              },
            },
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
            method: 'item/completed',
            params: {
              item: {
                type: 'agentMessage',
                id: 'msg_1',
                text: 'hello world',
                phase: 'final_answer',
              },
            },
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
    expect(
      events.some(
        (e): e is Extract<TurnEvent, { type: 'content_block_upsert' }> =>
          e.type === 'content_block_upsert' &&
          e.itemId === 'msg_1' &&
          e.block.id === 'msg_1-text' &&
          e.completed === true,
      ),
    ).toBe(true)
  })

  test('真实 codex turn id 返回前停止，会在 id 绑定后补发 interrupt', async () => {
    const { spawner, stdout, stdin } = createMockSpawner()
    const adapter = new CodexAdapter({ spawner })
    const methods: string[] = []

    stdin.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        const msg = JSON.parse(line)
        methods.push(msg.method)
        if (msg.method === 'initialize') {
          pushLine(stdout, { id: msg.id, result: { ok: true } })
        } else if (msg.method === 'model/list') {
          pushLine(stdout, {
            id: msg.id,
            result: { data: [{ id: 'gpt-5.2-codex', displayName: 'gpt-5.2-codex' }] },
          })
        } else if (msg.method === 'turn/start') {
          pushLine(stdout, { id: msg.id, result: { turn: { id: 'codex_turn_pending' } } })
        } else if (msg.method === 'turn/interrupt') {
          expect(msg.params).toEqual({ threadId: 'thr_1', turnId: 'codex_turn_pending' })
          pushLine(stdout, { id: msg.id, result: {} })
          pushLine(stdout, {
            method: 'turn/completed',
            params: { turn: { id: 'codex_turn_pending', status: 'interrupted', items: [] } },
          })
        }
      }
    })

    const iter = adapter.startTurn({ sessionId: 'thr_1', prompt: 'hi' })[Symbol.asyncIterator]()
    const started = await iter.next()
    expect(started.value).toMatchObject({ type: 'turn_started' })

    await adapter.interrupt(started.value!.turnId)
    const remaining: TurnEvent[] = []
    for (let next = await iter.next(); !next.done; next = await iter.next()) {
      remaining.push(next.value)
    }

    expect(methods).toContain('turn/interrupt')
    expect(remaining).toContainEqual(
      expect.objectContaining({ type: 'turn_completed', status: 'interrupted' }),
    )
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

  test('Computer Use MCP elicitation 显示授权并回传持久允许', async () => {
    const { spawner, stdout, stdin } = createMockSpawner()
    const adapter = new CodexAdapter({ spawner })
    const clientFrames: Array<Record<string, unknown>> = []

    stdin.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        const msg = JSON.parse(line) as Record<string, unknown>
        clientFrames.push(msg)
        if (msg.method === 'initialize') {
          pushLine(stdout, { id: msg.id, result: { ok: true } })
        } else if (msg.method === 'model/list' && msg.id !== undefined) {
          pushLine(stdout, {
            id: msg.id,
            result: { data: [{ id: 'gpt-5.2-codex', displayName: 'gpt-5.2-codex' }] },
          })
        } else if (msg.method === 'turn/start' && msg.id !== undefined) {
          pushLine(stdout, { id: msg.id, result: { turn: { id: 'codex_turn_mcp' } } })
          pushLine(stdout, {
            method: 'turn/started',
            params: { turn: { id: 'codex_turn_mcp', status: 'in_progress', items: [] } },
          })
          pushLine(stdout, {
            method: 'mcpServer/elicitation/request',
            id: 77,
            params: {
              threadId: 'thr_mcp',
              turnId: 'codex_turn_mcp',
              serverName: 'computer-use',
              mode: 'openai/form',
              message: 'Allow Computer Use to control Calculator?',
              requestedSchema: {
                type: 'object',
                properties: {
                  allowPersistentApproval: { type: 'boolean' },
                },
                additionalProperties: false,
              },
              _meta: {
                codex_approval_kind: 'mcp_tool_call',
                persist: ['session', 'always'],
              },
            },
          })
        } else if (msg.id === 77 && msg.result !== undefined) {
          pushLine(stdout, {
            method: 'turn/completed',
            params: { turn: { id: 'codex_turn_mcp', status: 'completed', items: [] } },
          })
        }
      }
    })

    const collectPromise = collectEvents(
      adapter.startTurn({
        sessionId: 'thr_mcp',
        prompt: '打开计算器',
        permissionMode: 'dontAsk',
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 100))

    await adapter.respondApproval({ requestId: '77', action: 'approve_always' })
    const events = await collectPromise

    const approval = events.find(
      (event): event is Extract<TurnEvent, { type: 'approval_requested' }> =>
        event.type === 'approval_requested',
    )
    expect(approval?.request).toMatchObject({
      kind: 'mcp',
      displayName: 'Computer Use',
      approvalPersistence: ['session', 'always'],
    })

    const turnStart = clientFrames.find((frame) => frame.method === 'turn/start')
    expect(turnStart?.params).toMatchObject({
      approvalPolicy: {
        granular: {
          mcp_elicitations: true,
          rules: false,
          sandbox_approval: false,
        },
      },
    })
    const elicitationResponse = clientFrames.find((frame) => frame.id === 77)
    expect(elicitationResponse?.result).toEqual({
      action: 'accept',
      content: { allowPersistentApproval: true },
      _meta: { persist: 'always' },
    })
    expect(events.some((event) => event.type === 'turn_completed')).toBe(true)
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

    const capturedTurnStart: Array<{ params: { model: string } }> = []
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
          capturedTurnStart.push(msg as { params: { model: string } })
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
    const events: TurnEvent[] = []
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

  test('turn/start 撞上 "thread not found" 时先 resume 再重试（后端进程换过）', async () => {
    // 复现：用户开着一个会话正常聊天 → 在设置里翻转协议桥开关 → codex 被 dispose
    // 并重新 spawn → 新进程内存里没有这个 thread → 下一条消息报
    // "thread not found: <id>"。rollout 文件还在磁盘上，resume 能把 thread 冷装回内存。
    const { spawner, stdout, stdin } = createMockSpawner()
    const adapter = new CodexAdapter({ spawner })

    const methods: string[] = []
    let turnStartSeen = 0
    let threadInMemory = false
    stdin.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        const msg = JSON.parse(line)
        if (msg.method === 'initialize') {
          pushLine(stdout, { id: msg.id, result: { ok: true } })
          continue
        }
        if (msg.id === undefined) continue
        if (msg.method === 'model/list') {
          pushLine(stdout, {
            id: msg.id,
            result: { data: [{ id: 'deepseek-v4-pro', displayName: 'ds', isDefault: true }] },
          })
          continue
        }
        methods.push(msg.method)
        if (msg.method === 'thread/resume') {
          threadInMemory = true
          pushLine(stdout, { id: msg.id, result: { thread: { id: 'thr_lost' } } })
        } else if (msg.method === 'turn/start') {
          turnStartSeen++
          if (!threadInMemory) {
            // 新 spawn 的 app-server：内存里没有这个 thread
            pushLine(stdout, {
              id: msg.id,
              error: { code: -32000, message: 'thread not found: thr_lost' },
            })
            continue
          }
          pushLine(stdout, { id: msg.id, result: { turn: { id: 'turn_1' } } })
          pushLine(stdout, {
            method: 'turn/completed',
            params: { turn: { id: 'turn_1', status: 'completed', items: [] } },
          })
        }
      }
    })

    const events: TurnEvent[] = []
    for await (const ev of adapter.startTurn({
      sessionId: 'thr_lost',
      prompt: 'hi',
      model: 'deepseek-v4-pro',
    })) {
      events.push(ev)
    }

    // resume 夹在两次 turn/start 之间（initialize 后的 model/list 预热与本用例无关）
    expect(methods.filter((m) => m !== 'model/list')).toEqual([
      'turn/start',
      'thread/resume',
      'turn/start',
    ])
    expect(turnStartSeen).toBe(2)
    // 用户侧看不到任何错误，这一轮正常完成
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed', status: 'completed' })
  })

  test('resume 也救不回来时报错，不无限重试', async () => {
    // rollout 文件也没了（被删/损坏）——只重试一次，错误如实抛给用户
    const { spawner, stdout, stdin } = createMockSpawner()
    const adapter = new CodexAdapter({ spawner })

    let turnStartSeen = 0
    stdin.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        const msg = JSON.parse(line)
        if (msg.method === 'initialize') {
          pushLine(stdout, { id: msg.id, result: { ok: true } })
        } else if (msg.method === 'model/list' && msg.id !== undefined) {
          pushLine(stdout, {
            id: msg.id,
            result: { data: [{ id: 'deepseek-v4-pro', displayName: 'ds', isDefault: true }] },
          })
        } else if (msg.method === 'turn/start' && msg.id !== undefined) {
          turnStartSeen++
          pushLine(stdout, {
            id: msg.id,
            error: { code: -32000, message: 'thread not found: thr_gone' },
          })
        } else if (msg.method === 'thread/resume' && msg.id !== undefined) {
          pushLine(stdout, {
            id: msg.id,
            error: { code: -32000, message: 'no rollout found for thread id thr_gone' },
          })
        }
      }
    })

    const events: TurnEvent[] = []
    for await (const ev of adapter.startTurn({
      sessionId: 'thr_gone',
      prompt: 'hi',
      model: 'deepseek-v4-pro',
    })) {
      events.push(ev)
    }

    expect(turnStartSeen).toBe(1)
    expect(events.some((e) => e.type === 'error')).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed', status: 'error' })
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
        } else if (msg.method === 'thread/resume' && msg.id !== undefined) {
          pushLine(stdout, { id: msg.id, result: { thread: { id: 'thr_1' } } })
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

  test('getHistory resumes the thread before reading, so a later turn/start does not fail with "thread not found"', async () => {
    // Reproduces: user opens a history-loaded codex session, sends a 2nd turn,
    // codex app-server returns "thread not found" because the long-running
    // app-server process forgot the thread (process restart, idle eviction...).
    // thread/read works on cold rollout state, but turn/start requires the
    // thread to be registered in memory. Fix: getHistory must call thread/resume
    // first to load the thread into the app-server.
    const { spawner, stdout, stdin } = createMockSpawner()
    const adapter = new CodexAdapter({ spawner })

    // 记录请求顺序——验证 thread/resume 在 thread/read 之前
    const requests: { id: number; method: string; params: unknown }[] = []
    stdin.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        const msg = JSON.parse(line)
        if (msg.method === 'initialize') {
          pushLine(stdout, { id: msg.id, result: { ok: true } })
        } else if (msg.method === 'thread/resume' && msg.id !== undefined) {
          requests.push({ id: msg.id, method: msg.method, params: msg.params })
          pushLine(stdout, { id: msg.id, result: { thread: { id: 'thr_resume' } } })
        } else if (msg.method === 'thread/read' && msg.id !== undefined) {
          requests.push({ id: msg.id, method: msg.method, params: msg.params })
          pushLine(stdout, {
            id: msg.id,
            result: { thread: { id: 'thr_resume', turns: [] } },
          })
        }
      }
    })

    await adapter.getHistory('thr_resume')

    const methods = requests.map((r) => r.method)
    expect(methods).toContain('thread/resume')
    expect(methods).toContain('thread/read')
    // 顺序：resume 必须在 read 之前
    expect(methods.indexOf('thread/resume')).toBeLessThan(methods.indexOf('thread/read'))
    // resume 带正确的 threadId
    const resumeReq = requests.find((r) => r.method === 'thread/resume')
    expect((resumeReq?.params as { threadId?: string }).threadId).toBe('thr_resume')
  })

  test('getHistory 将首个 turn 尚未执行的 thread 视为空历史', async () => {
    const { spawner, stdout, stdin } = createMockSpawner()
    const adapter = new CodexAdapter({ spawner })

    stdin.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        const msg = JSON.parse(line)
        if (msg.method === 'initialize') {
          pushLine(stdout, { id: msg.id, result: { ok: true } })
        } else if (msg.method === 'thread/resume' && msg.id !== undefined) {
          pushLine(stdout, {
            id: msg.id,
            error: {
              code: -32000,
              message: 'no rollout found for thread id thr_pending',
            },
          })
        } else if (msg.method === 'thread/read' && msg.id !== undefined) {
          pushLine(stdout, {
            id: msg.id,
            error: {
              code: -32000,
              message:
                'thread thr_pending is not materialized yet; includeTurns is unavailable before first user message',
            },
          })
        }
      }
    })

    await expect(adapter.getHistory('thr_pending')).resolves.toEqual({ messages: [] })
  })
})
