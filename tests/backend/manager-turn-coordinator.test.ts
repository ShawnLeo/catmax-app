// @vitest-environment node
import type { MainBackendPlugin } from '@main/backend/plugin-registry'
import type { BackendCapabilities } from '@shared/backend/types'
import type { AgentBackend, StartTurnArgs, TurnEvent } from '@shared/backend/types'
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
  supportsSteer: true,
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

function makePlugin(
  id: BackendId,
  startTurn: (args: StartTurnArgs) => AsyncIterable<TurnEvent>,
): {
  plugin: MainBackendPlugin
  interrupt: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
} {
  const interrupt = vi.fn(async (_turnId: string) => {})
  const steer = vi.fn(async (_turnId: string, _prompt: string) => {})
  const adapter: AgentBackend = {
    id,
    capabilities,
    initialize: vi.fn(async () => {}),
    healthCheck: vi.fn(async () => ({ ok: true })),
    dispose: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
    getCapabilities: () => capabilities,
    startSession: vi.fn(async () => ({ sessionId: 'session', backendThreadId: 'thread' })),
    listSessions: vi.fn(async () => []),
    resumeSession: vi.fn(async () => ({ messages: [] })),
    getHistory: vi.fn(async () => ({ messages: [] })),
    startTurn,
    interrupt,
    respondApproval: vi.fn(async () => {}),
    steer,
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
    interrupt,
    steer,
  }
}

describe('BackendManager per-turn coordinator integration', () => {
  beforeEach(() => {
    contextMocks.broadcast.mockReset()
    contextMocks.bumpSessionTurn.mockReset()
  })

  test('复用 clientTurnId，剥离协调元数据，并在切 backend 后路由到原 adapter', async () => {
    const beforeCodexStarted = deferred()
    const completeCodex = deferred()
    const receivedArgs: StartTurnArgs[] = []
    const codex = makePlugin('codex', async function* (args) {
      receivedArgs.push(args)
      await beforeCodexStarted.promise
      yield { type: 'turn_started', turnId: 'backend-turn', sessionId: args.sessionId }
      await completeCodex.promise
      yield { type: 'turn_completed', turnId: 'backend-turn', status: 'completed' }
    })
    const claude = makePlugin('claude', async function* (args) {
      yield { type: 'turn_started', turnId: 'claude-turn', sessionId: args.sessionId }
      yield { type: 'turn_completed', turnId: 'claude-turn', status: 'completed' }
    })
    const manager = new BackendManager([codex.plugin, claude.plugin])

    await expect(
      manager.startTurn({
        clientTurnId: 'client-turn',
        clientSessionId: 'catmax-session',
        sessionId: 'backend-session',
        prompt: '分析',
      }),
    ).resolves.toEqual({ turnId: 'client-turn' })
    await flushTasks()

    expect(receivedArgs).toEqual([
      {
        clientSessionId: 'catmax-session',
        sessionId: 'backend-session',
        prompt: '分析',
      },
    ])

    // backend turn id 尚未建立时提交 steer；协调器应暂存，而不是拿 client id 调 adapter。
    await manager.steerTurn('client-turn', '补充协议转换检查')
    expect(codex.steer).not.toHaveBeenCalled()
    beforeCodexStarted.resolve()
    await flushTasks()
    expect(codex.steer).toHaveBeenCalledWith('backend-turn', '补充协议转换检查')

    await manager.switchBackend('claude')
    await manager.interruptTurn('client-turn')

    expect(codex.interrupt).toHaveBeenCalledWith('backend-turn')
    expect(claude.steer).not.toHaveBeenCalled()
    expect(claude.interrupt).not.toHaveBeenCalled()

    completeCodex.resolve()
    await flushTasks()

    expect(contextMocks.broadcast).toHaveBeenCalledWith(
      'backend:turnEvent',
      expect.objectContaining({
        turnId: 'client-turn',
        sessionId: 'catmax-session',
        event: expect.objectContaining({
          type: 'turn_completed',
          status: 'interrupted',
        }),
      }),
    )
    expect(contextMocks.bumpSessionTurn).toHaveBeenCalledOnce()
  })

  test('不同 session 的 Codex turn 共用单一 backend lane，避免 app-server sink 串流', async () => {
    const completeFirst = deferred()
    const startedSessions: string[] = []
    const codex = makePlugin('codex', async function* (args) {
      startedSessions.push(args.sessionId)
      yield {
        type: 'turn_started',
        turnId: `turn-${args.sessionId}`,
        sessionId: args.sessionId,
      }
      if (args.sessionId === 'backend-session-1') await completeFirst.promise
      yield {
        type: 'turn_completed',
        turnId: `turn-${args.sessionId}`,
        status: 'completed',
      }
    })
    const manager = new BackendManager([codex.plugin])

    await manager.startTurn({
      clientTurnId: 'client-turn-1',
      clientSessionId: 'catmax-session-1',
      sessionId: 'backend-session-1',
      prompt: 'one',
    })
    await manager.startTurn({
      clientTurnId: 'client-turn-2',
      clientSessionId: 'catmax-session-2',
      sessionId: 'backend-session-2',
      prompt: 'two',
    })
    await flushTasks()

    expect(startedSessions).toEqual(['backend-session-1'])

    completeFirst.resolve()
    await flushTasks()
    await flushTasks()

    expect(startedSessions).toEqual(['backend-session-1', 'backend-session-2'])
    expect(contextMocks.broadcast).toHaveBeenCalledWith(
      'backend:turnEvent',
      expect.objectContaining({
        sessionId: 'catmax-session-2',
        event: expect.objectContaining({ type: 'turn_completed' }),
      }),
    )
  })
})
