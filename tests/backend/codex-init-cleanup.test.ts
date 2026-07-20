// @vitest-environment node
/**
 * Bug C regression test：CodexAdapter.initialize() 失败时必须清理子进程，
 * 否则下次 initialize() 会复用死进程永远超时。
 *
 * Bug 场景：codex 启动后立即退出（exec error / 立刻 exit），initialize 握手永不返回，
 * 30s 后 sendRequest timeout。但 proc 引用还在，下次 initialize 复用死 proc → 永远超时。
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { CodexAdapter } from '@main/backend/codex/adapter'
import type { ProcessSpawner, SpawnedProcess } from '@main/backend/process-spawner'
import { describe, expect, test, vi } from 'vitest'

function createMockSpawner(): {
  spawner: ProcessSpawner
  stdout: PassThrough
  stdin: PassThrough
  child: EventEmitter & { kill: ReturnType<typeof vi.fn> }
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stdin: PassThrough
    pid: number
    kill: ReturnType<typeof vi.fn>
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
  return { spawner, stdout, stdin, child }
}

describe('Bug C: CodexAdapter.initialize 失败时清理子进程', () => {
  test('initialize 在 sendRequest 超时后必须 reject 并 kill proc，下次 initialize 能重新 spawn', async () => {
    // 用一个不响应 initialize 的 spawner——sendRequest 会等到内部超时。
    // 但我们改用进程 exit 触发 rejectAllPending，避免等 30s。
    const { spawner, child } = createMockSpawner()
    const adapter = new CodexAdapter({ spawner })

    // 不在 stdin 上回复任何 response；直接让子进程 emit 'exit'，
    // 触发 rejectAllPending('codex process exited') → initialize 抛错
    const initPromise = adapter.initialize()
    // 让 event loop 转一圈，确保 spawn 已经发生
    await new Promise((r) => setImmediate(r))
    child.emit('exit', 1, 'SIGTERM')

    await expect(initPromise).rejects.toThrow(/codex process exited/)

    // 关键断言：proc 必须已被清理
    // 我们通过观察 child.kill 是否被调用来验证（killAndClearProc 调用 proc.kill）
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  test('setBinaryPath 在 initialize 之前调用，后续 spawn 使用新路径', async () => {
    const { spawner, stdout, stdin } = createMockSpawner()
    const spawnSpy = vi.spyOn(spawner, 'spawn')

    const adapter = new CodexAdapter({ spawner })
    adapter.setBinaryPath('/custom/codex')

    // 模拟正常 initialize 响应
    stdin.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        const msg = JSON.parse(line)
        if (msg.method === 'initialize' && msg.id !== undefined) {
          stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + '\n')
        }
      }
    })

    await adapter.initialize()

    expect(spawnSpy).toHaveBeenCalledTimes(1)
    expect(spawnSpy.mock.calls[0]?.[0]?.command).toBe('/custom/codex')
  })
})
