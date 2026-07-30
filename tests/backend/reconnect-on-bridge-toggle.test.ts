// @vitest-environment node
//
// 验证「协议桥配置变化后自动重连 codex」的核心机制：
// - reconnectBackend 先 interruptBackend 清空活跃 turn，再 dispose + initialize
// - interruptBackend 只结算指定 backend 的 turn，不动其他 backend
// - 进行中的 turn 被结算成 interrupted（不是静默丢失）
import type { MainBackendPlugin } from '@main/backend/plugin-registry'
import type {
  AgentBackend,
  BackendCapabilities,
  StartTurnArgs,
  TurnEvent,
} from '@shared/backend/types'
import type { BackendId } from '@shared/constants'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const contextMocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  bumpSessionTurn: vi.fn(),
}))

vi.mock('@main/context', () => ({
  ctx: {
    broadcast: contextMocks.broadcast,
    db: {
      bumpSessionTurn: contextMocks.bumpSessionTurn,
    },
  },
}))

const { BackendManager } = await import('@main/backend/manager')

const capabilities: BackendCapabilities = {
  supportsInterrupt: true,
  supportsApproval: true,
  supportsSteer: false,
  supportsThreadFork: false,
  supportsModelSelection: false,
  supportsEffort: false,
  supportsPermissionMode: false,
  supportedPermissionModes: [],
  supportedEfforts: [],
  supportsHotSwap: false,
  chat: {
    subAgents: false,
    compact: false,
    planMode: false,
    webTools: false,
    blockTypes: ['text'],
  },
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function flushTasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

interface FakeAdapter {
  adapter: AgentBackend
  initialize: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  interrupt: ReturnType<typeof vi.fn>
}

function makePlugin(
  id: BackendId,
  startTurn: (args: StartTurnArgs) => AsyncIterable<TurnEvent>,
): { plugin: MainBackendPlugin } & FakeAdapter {
  const initialize = vi.fn(async () => {})
  const dispose = vi.fn(async () => {})
  const interrupt = vi.fn(async (_turnId: string) => {})
  const adapter: AgentBackend = {
    id,
    capabilities,
    initialize,
    healthCheck: vi.fn(async () => ({ ok: true })),
    dispose,
    listModels: vi.fn(async () => []),
    getCapabilities: () => capabilities,
    startSession: vi.fn(async () => ({ sessionId: 'session', backendThreadId: 'thread' })),
    listSessions: vi.fn(async () => []),
    resumeSession: vi.fn(async () => ({ messages: [] })),
    getHistory: vi.fn(async () => ({ messages: [] })),
    startTurn,
    interrupt,
    respondApproval: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
  }
  return {
    plugin: {
      manifest: {
        id,
        displayName: id,
        version: '1',
        blockTypes: ['text'],
        capabilities,
      },
      createAdapter: () => adapter,
    },
    adapter,
    initialize,
    dispose,
    interrupt,
  }
}

describe('reconnectBackend —— 协议桥配置变化后重连后端', () => {
  beforeEach(() => {
    contextMocks.broadcast.mockReset()
    contextMocks.bumpSessionTurn.mockReset()
  })

  test('reconnectBackend 调 dispose 再 initialize（各一次），重 spawn 进程', async () => {
    const codex = makePlugin('codex', async function* () {
      yield { type: 'turn_completed', turnId: 't', status: 'completed' }
    })
    const manager = new BackendManager([codex.plugin])

    await manager.reconnectBackend('codex')

    expect(codex.dispose).toHaveBeenCalledTimes(1)
    expect(codex.initialize).toHaveBeenCalledTimes(1)
  })

  test('reconnectBackend 先 interruptBackend 结算活跃 turn 再 dispose', async () => {
    // codex turn 卡住不结束——靠 reconnect 强制结算
    const blockTurn = deferred()
    const codex = makePlugin('codex', async function* (args) {
      yield { type: 'turn_started', turnId: 'backend-turn', sessionId: args.sessionId }
      await blockTurn.promise
      yield { type: 'turn_completed', turnId: 'backend-turn', status: 'completed' }
    })
    const manager = new BackendManager([codex.plugin])

    // 起一个 in-flight turn（不 await 完成）
    await manager.startTurn({
      clientTurnId: 'in-flight',
      clientSessionId: 's',
      sessionId: 'backend-s',
      prompt: 'hi',
    })
    await flushTasks()

    // 重连——卡住的 turn 应被结算成 interrupted
    await manager.reconnectBackend('codex')
    await flushTasks()

    expect(codex.dispose).toHaveBeenCalledTimes(1)
    expect(codex.initialize).toHaveBeenCalledTimes(1)
    // 被中断的 turn 通过广播通知 UI（interrupted，非静默丢失）
    expect(contextMocks.broadcast).toHaveBeenCalledWith(
      'backend:turnEvent',
      expect.objectContaining({
        turnId: 'in-flight',
        event: expect.objectContaining({
          type: 'turn_completed',
          status: 'interrupted',
        }),
      }),
    )
  })

  test('interruptBackend 只结算 codex 的 turn，不动 claude 的', async () => {
    const blockCodex = deferred()
    const codex = makePlugin('codex', async function* (args) {
      yield { type: 'turn_started', turnId: 'codex-turn', sessionId: args.sessionId }
      await blockCodex.promise
      yield { type: 'turn_completed', turnId: 'codex-turn', status: 'completed' }
    })
    const blockClaude = deferred()
    const claudeInterrupt = vi.fn(async (_t: string) => {})
    const claudeAdapter: AgentBackend = {
      id: 'claude',
      capabilities,
      initialize: vi.fn(async () => {}),
      healthCheck: vi.fn(async () => ({ ok: true })),
      dispose: vi.fn(async () => {}),
      listModels: vi.fn(async () => []),
      getCapabilities: () => capabilities,
      startSession: vi.fn(async () => ({ sessionId: 's', backendThreadId: 't' })),
      listSessions: vi.fn(async () => []),
      resumeSession: vi.fn(async () => ({ messages: [] })),
      getHistory: vi.fn(async () => ({ messages: [] })),
      async *startTurn(args) {
        yield { type: 'turn_started', turnId: 'claude-turn', sessionId: args.sessionId }
        await blockClaude.promise
        yield { type: 'turn_completed', turnId: 'claude-turn', status: 'completed' }
      },
      interrupt: claudeInterrupt,
      respondApproval: vi.fn(async () => {}),
      steer: vi.fn(async () => {}),
    }
    const claudePlugin: MainBackendPlugin = {
      manifest: {
        id: 'claude',
        displayName: 'claude',
        version: '1',
        blockTypes: ['text'],
        capabilities,
      },
      createAdapter: () => claudeAdapter,
    }
    const manager = new BackendManager([codex.plugin, claudePlugin])

    // claude 的 turn（claude 用 sessionId 做 laneKey，和 codex 的 backend:codex 隔离）
    await manager.switchBackend('claude')
    await manager.startTurn({
      clientTurnId: 'claude-in-flight',
      clientSessionId: 'claude-session',
      sessionId: 'claude-backend',
      prompt: 'hi',
    })
    // codex 的 turn
    await manager.switchBackend('codex')
    await manager.startTurn({
      clientTurnId: 'codex-in-flight',
      clientSessionId: 'codex-session',
      sessionId: 'codex-backend',
      prompt: 'hi',
    })
    await flushTasks()

    await manager.reconnectBackend('codex')
    await flushTasks()

    // codex 的 turn 被中断
    expect(codex.interrupt).toHaveBeenCalledWith('codex-turn')
    expect(contextMocks.broadcast).toHaveBeenCalledWith(
      'backend:turnEvent',
      expect.objectContaining({
        turnId: 'codex-in-flight',
        event: expect.objectContaining({ status: 'interrupted' }),
      }),
    )
    // claude 的 turn 没被动
    expect(claudeInterrupt).not.toHaveBeenCalled()
    blockClaude.resolve()
    blockCodex.resolve()
    await flushTasks()
  })
})
