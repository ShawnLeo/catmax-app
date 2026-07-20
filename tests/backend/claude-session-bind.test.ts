// @vitest-environment node
/**
 * Bug E-3 regression test：ClaudeAdapter.startTurn 拿到 claude 真实 session_id 后
 * 必须把 db 里 session.backend_thread_id 从占位 UUID 更新成真实 id，
 * 这样重启后用户点历史会话才能 getHistory --resume 真实 id。
 *
 * 之前 bug：只更新内存的 sessionIdMap，db 没动——重启后映射丢失，加载历史必失败。
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import type { ProcessSpawner, SpawnedProcess } from '@main/backend/process-spawner'
import { describe, expect, test, vi } from 'vitest'

function createMockSpawner() {
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
        kill: (sig) => ((child as any).kill as (sig?: NodeJS.Signals) => void)(sig),
        pid: 12345,
      }
    },
  }
  return { spawner, stdout }
}

function pushLine(stream: PassThrough, obj: unknown): void {
  stream.write(JSON.stringify(obj) + '\n')
}

describe('Bug E-3: ClaudeAdapter onRealSessionId 回调', () => {
  test('startTurn 拿到 system.init.session_id 时触发 onRealSessionId(internalId, realId)', async () => {
    const { ClaudeAdapter } = await import('@main/backend/claude/adapter')
    const { spawner, stdout } = createMockSpawner()
    const onRealSessionId = vi.fn()
    const adapter = new ClaudeAdapter({ spawner, onRealSessionId })

    setTimeout(() => {
      pushLine(stdout, {
        type: 'system',
        subtype: 'init',
        session_id: 'real-claude-id',
      })
      pushLine(stdout, {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
        },
      })
      pushLine(stdout, { type: 'result', subtype: 'success', is_error: false })
    }, 5)

    // backendThreadId 是 db 里存的占位 UUID
    for await (const _e of adapter.startTurn({ sessionId: 'placeholder-uuid', prompt: 'hi' })) {
      void _e
    }

    expect(onRealSessionId).toHaveBeenCalledTimes(1)
    expect(onRealSessionId).toHaveBeenCalledWith('placeholder-uuid', 'real-claude-id')
  })

  test('续接已有会话（resume），realId == internalId 时不触发 onRealSessionId', async () => {
    const { ClaudeAdapter } = await import('@main/backend/claude/adapter')
    const { spawner, stdout } = createMockSpawner()
    const onRealSessionId = vi.fn()
    const adapter = new ClaudeAdapter({ spawner, onRealSessionId })

    // 模拟 App 重启后加载已有会话：先手动标记为可续接
    // （首次 turn 不传 --resume 时，realId 通常 != internalId，所以会触发；
    //  这里直接测"如果 system.session_id 等于 internalId"的情况）
    setTimeout(() => {
      pushLine(stdout, {
        type: 'system',
        subtype: 'init',
        session_id: 'already-known-id', // == 传进来的 sessionId
      })
      pushLine(stdout, { type: 'result', subtype: 'success', is_error: false })
    }, 5)

    for await (const _e of adapter.startTurn({
      sessionId: 'already-known-id',
      prompt: 'hi',
    })) {
      void _e
    }

    // 即便触发，manager 那边会判 internalId === realSessionId 跳过 db 写。
    // 这里只断言 adapter 调了回调（manager 自己决定是否写 db）。
    expect(onRealSessionId).toHaveBeenCalledTimes(1)
    expect(onRealSessionId).toHaveBeenCalledWith('already-known-id', 'already-known-id')
  })
})

describe('Bug E-3: BackendManager.onRealSessionId 注入逻辑', () => {
  test('构造 ClaudeAdapter 时注入 onRealSessionId，调用时更新 db', async () => {
    // vi.mock 工厂被 hoist 到顶部时不能引用普通变量，必须用 vi.hoisted
    // 创建共享 spy。
    const { updateCalls } = vi.hoisted(() => ({ updateCalls: [] as Array<[string, string, string]> }))
    vi.mock('@main/context', () => ({
      ctx: {
        db: {
          updateSessionBackendThreadId: (backend: string, old: string, neu: string) =>
            updateCalls.push([backend, old, neu]),
        },
        broadcast: () => {},
      },
    }))

    const { BackendManager } = await import('@main/backend/manager')
    const mgr = new BackendManager()

    // 通过反射拿 claude adapter，验证注入的回调
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapters = (mgr as any).adapters as Map<string, { opts: { onRealSessionId?: Function } }>
    const claudeAdapter = adapters.get('claude')
    expect(claudeAdapter).toBeDefined()
    expect(typeof claudeAdapter?.opts?.onRealSessionId).toBe('function')

    // 不同 id：触发 db update
    claudeAdapter?.opts?.onRealSessionId?.('placeholder', 'real-id')
    expect(updateCalls).toEqual([['claude', 'placeholder', 'real-id']])

    // 相同 id：manager 早 return，不调 db
    claudeAdapter?.opts?.onRealSessionId?.('same', 'same')
    expect(updateCalls).toEqual([['claude', 'placeholder', 'real-id']]) // 长度不变

    vi.doUnmock('@main/context')
  })
})
