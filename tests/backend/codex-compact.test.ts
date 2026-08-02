/**
 * codex 的命令 turn（Composer 的 `/compact`）。
 *
 * 为什么它是一个 turn 而不是一次普通 RPC：实测 `thread/compact/start` 会发出
 * `turn/started` + `item/started`。绕过 startTurn 直接发这个 RPC，事件会挂在
 * PerTurnCoordinator 不认识的 turnId 上，watchdog / cancel / exactly-one-terminal
 * 三个保证同时失效，而且绕过 per-session 串行化。所以它走 StartTurnArgs.command。
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { CodexAdapter } from '@main/backend/codex/adapter'
import type { ProcessSpawner, SpawnedProcess } from '@main/backend/process-spawner'
import type { TurnEvent } from '@shared/backend/types'
import { describe, expect, test, vi } from 'vitest'

interface Captured {
  method: string
  params: Record<string, unknown>
}

/**
 * 一个只认识 initialize / model/list / thread/compact/start / turn/start 的 app-server。
 * 收到 turn 请求后立刻回 turn/completed，让 startTurn 的循环能正常收尾。
 */
function createSpawner(): { spawner: ProcessSpawner; captured: Captured[] } {
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  const captured: Captured[] = []

  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  Object.assign(child, { stdout, stdin, pid: 4242, kill: vi.fn() })

  const push = (obj: unknown): void => {
    stdout.write(`${JSON.stringify(obj)}\n`)
  }

  stdin.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      const msg = JSON.parse(line) as { id?: number; method?: string; params?: unknown }
      if (msg.method === 'initialize') {
        push({ id: msg.id, result: { ok: true } })
        continue
      }
      if (msg.id === undefined) continue
      if (msg.method === 'model/list') {
        push({
          id: msg.id,
          result: { data: [{ id: 'gpt-5-codex', displayName: 'g', isDefault: true }] },
        })
        continue
      }
      captured.push({
        method: msg.method!,
        params: (msg.params ?? {}) as Record<string, unknown>,
      })
      if (msg.method === 'thread/compact/start') {
        // 真实响应就是个空对象——拿不到 turn id，只能靠随后的 turn/started 通知。
        push({ id: msg.id, result: {} })
        push({ method: 'turn/started', params: { turn: { id: 'turn_c' } } })
        push({
          method: 'turn/completed',
          params: { turn: { id: 'turn_c', status: 'completed', items: [] } },
        })
      } else if (msg.method === 'turn/start') {
        push({ id: msg.id, result: { turn: { id: 'turn_1' } } })
        push({
          method: 'turn/completed',
          params: { turn: { id: 'turn_1', status: 'completed', items: [] } },
        })
      }
    }
  })

  const spawner: ProcessSpawner = {
    spawn(): SpawnedProcess {
      return {
        child: child as unknown as SpawnedProcess['child'],
        write: (data) => stdin.write(data),
        endInput: () => stdin.end(),
        kill: () => {},
        pid: 4242,
      }
    },
  }
  return { spawner, captured }
}

async function collect(iter: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const events: TurnEvent[] = []
  for await (const ev of iter) events.push(ev)
  return events
}

describe('codex 命令 turn', () => {
  test('command=compact 时发 thread/compact/start，而不是把 /compact 当消息发出去', async () => {
    // 这正是不加这条分支时会发生的事：codex 不拦截斜杠命令，`/compact` 会被原样
    // 交给模型，用户看到模型茫然地问"你要我压缩什么"。
    const { spawner, captured } = createSpawner()
    const adapter = new CodexAdapter({ spawner })

    const events = await collect(
      adapter.startTurn({ sessionId: 'thr_1', prompt: '/compact', command: { kind: 'compact' } }),
    )

    const turnCalls = captured.filter((c) => c.method !== 'model/list')
    expect(turnCalls).toEqual([{ method: 'thread/compact/start', params: { threadId: 'thr_1' } }])
    expect(events.some((e) => e.type === 'turn_completed')).toBe(true)
  })

  test('不带 command 的普通消息仍走 turn/start', async () => {
    const { spawner, captured } = createSpawner()
    const adapter = new CodexAdapter({ spawner })

    await collect(adapter.startTurn({ sessionId: 'thr_1', prompt: '你好' }))

    const methods = captured.map((c) => c.method).filter((m) => m !== 'model/list')
    expect(methods).toEqual(['turn/start'])
  })

  test('不认识的命令报错，而不是静默降级成普通消息', async () => {
    // 静默降级的表现是"命令时灵时不灵"，比一条明确的错误难查得多。
    const { spawner, captured } = createSpawner()
    const adapter = new CodexAdapter({ spawner })

    const events = await collect(
      adapter.startTurn({
        sessionId: 'thr_1',
        prompt: '/whatever',
        command: { kind: 'not-a-command' } as never,
      }),
    )

    expect(captured.filter((c) => c.method !== 'model/list')).toEqual([])
    const error = events.find((e) => e.type === 'error')
    expect(error).toBeDefined()
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed', status: 'error' })
  })
})
