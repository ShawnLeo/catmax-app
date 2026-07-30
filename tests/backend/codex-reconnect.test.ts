import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { CodexAdapter } from '@main/backend/codex/adapter'
import type { ProcessSpawner, SpawnedProcess } from '@main/backend/process-spawner'
import { describe, expect, test, vi } from 'vitest'

interface FakeProc {
  child: EventEmitter & { stdout: PassThrough; stdin: PassThrough }
  stdout: PassThrough
  stdin: PassThrough
  killed: boolean
}

/**
 * 每次 spawn 都造一个**新的**子进程（真实行为）。默认 mock 复用同一个 child，
 * 就复现不出「上一个进程的迟到事件打到新进程头上」这类 bug。
 *
 * kill 时不同步发 exit——真实进程的 exit 是下一个 tick 才到的，这个时间差正是 bug 的成因。
 */
function createReconnectSpawner(options: { autoHandshake?: boolean } = {}): {
  spawner: ProcessSpawner
  procs: FakeProc[]
} {
  const procs: FakeProc[] = []

  const spawner: ProcessSpawner = {
    spawn(): SpawnedProcess {
      const stdout = new PassThrough()
      const stdin = new PassThrough()
      const child = new EventEmitter() as FakeProc['child']
      Object.assign(child, { stdout, stdin, pid: 1000 + procs.length })

      const proc: FakeProc = { child, stdout, stdin, killed: false }
      procs.push(proc)

      if (options.autoHandshake !== false) {
        stdin.on('data', (data: Buffer) => {
          for (const line of data.toString().split('\n').filter(Boolean)) {
            const msg = JSON.parse(line) as { id?: number; method?: string }
            if (msg.method === 'initialize' && msg.id !== undefined) {
              stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\n')
            }
          }
        })
      }

      return {
        child: child as unknown as SpawnedProcess['child'],
        write: (data) => stdin.write(data),
        endInput: () => stdin.end(),
        kill: () => {
          proc.killed = true
          // 真实进程：exit 是异步到达的
          setTimeout(() => child.emit('exit', 0, null), 0)
        },
        pid: 1000 + procs.length,
      }
    },
  }
  return { spawner, procs }
}

describe('CodexAdapter 重连（协议桥开关翻转会走这条路）', () => {
  test('旧进程迟到的 exit 事件不能打断新进程的握手', async () => {
    const { spawner, procs } = createReconnectSpawner({ autoHandshake: false })
    const adapter = new CodexAdapter({ spawner })

    // 第一次 initialize：手动回握手
    const first = adapter.initialize()
    await vi.waitFor(() => expect(procs.length).toBe(1))
    procs[0]!.stdin.once('data', (d: Buffer) => {
      const msg = JSON.parse(d.toString().split('\n')[0]!) as { id: number }
      procs[0]!.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\n')
    })
    await first

    // dispose 只 kill，exit 事件下一个 tick 才到
    await adapter.dispose()

    // 立刻重连——新进程的握手请求此时已经挂在共享的 pendingRequests 里，
    // 而旧进程的 exit 事件还在路上
    const second = adapter.initialize()
    await vi.waitFor(() => expect(procs.length).toBe(2))
    // 让旧进程的 exit 先落地，再回新进程的握手
    await new Promise((resolve) => setTimeout(resolve, 10))
    procs[1]!.stdin.once('data', (d: Buffer) => {
      const msg = JSON.parse(d.toString().split('\n')[0]!) as { id: number }
      procs[1]!.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\n')
    })

    await expect(second).resolves.toBeUndefined()
  })

  test('连续 dispose + initialize 后适配器仍可用', async () => {
    const { spawner, procs } = createReconnectSpawner()
    const adapter = new CodexAdapter({ spawner })

    await adapter.initialize()
    for (let i = 0; i < 3; i++) {
      await adapter.dispose()
      await adapter.initialize()
    }
    // 每轮都真的换了新进程
    expect(procs.length).toBe(4)
    // 迟到的 exit 全部落地后，状态不该被搅乱
    await new Promise((resolve) => setTimeout(resolve, 20))
    await expect(adapter.initialize()).resolves.toBeUndefined()
    expect(procs.length).toBe(4)
  })
})
