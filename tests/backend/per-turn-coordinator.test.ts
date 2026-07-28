// @vitest-environment node
import { PerTurnCoordinator } from '@main/backend/turn/per-turn-coordinator'
import { InMemoryTurnRunRepository } from '@main/backend/turn/turn-run-repository'
import type { TurnEvent } from '@shared/backend/types'
import type { TurnRunRecord } from '@shared/domain'
import { afterEach, describe, expect, test, vi } from 'vitest'

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

describe('PerTurnCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('同 session 的 turn 按 FIFO 串行执行', async () => {
    const coordinator = new PerTurnCoordinator()
    const firstGate = deferred()
    const started: string[] = []
    const events: TurnEvent[] = []

    coordinator.enqueue({
      id: 'turn-1',
      sessionId: 'session-1',
      backend: 'claude',
      run: async (sink) => {
        started.push('turn-1')
        sink.publish({ type: 'turn_started', turnId: 'backend-1', sessionId: 'session-1' })
        await firstGate.promise
        sink.publish({ type: 'turn_completed', turnId: 'backend-1', status: 'completed' })
      },
      interrupt: vi.fn(async () => {}),
      onEvent: (event) => events.push(event),
    })
    coordinator.enqueue({
      id: 'turn-2',
      sessionId: 'session-1',
      backend: 'claude',
      run: async (sink) => {
        started.push('turn-2')
        sink.publish({ type: 'turn_started', turnId: 'backend-2', sessionId: 'session-1' })
        sink.publish({ type: 'turn_completed', turnId: 'backend-2', status: 'completed' })
      },
      interrupt: vi.fn(async () => {}),
      onEvent: (event) => events.push(event),
    })

    expect(started).toEqual(['turn-1'])
    expect(coordinator.list().find((record) => record.id === 'turn-1')?.status).toBe('running')
    expect(coordinator.list().find((record) => record.id === 'turn-2')?.status).toBe('queued')

    firstGate.resolve()
    await flushTasks()
    await flushTasks()

    expect(started).toEqual(['turn-1', 'turn-2'])
    expect(events.filter((event) => event.type === 'turn_completed')).toHaveLength(2)
    expect(coordinator.list().every((record) => record.status === 'completed')).toBe(true)
  })

  test('不同 session 的 turn 可以并行执行', async () => {
    const coordinator = new PerTurnCoordinator()
    const gates = [deferred(), deferred()]
    const started: string[] = []

    for (const [index, sessionId] of ['session-1', 'session-2'].entries()) {
      coordinator.enqueue({
        id: `turn-${index}`,
        sessionId,
        backend: 'claude',
        run: async (sink) => {
          started.push(sessionId)
          sink.publish({
            type: 'turn_started',
            turnId: `backend-${index}`,
            sessionId,
          })
          await gates[index]!.promise
          sink.publish({
            type: 'turn_completed',
            turnId: `backend-${index}`,
            status: 'completed',
          })
        },
        interrupt: vi.fn(async () => {}),
        onEvent: vi.fn(),
      })
    }

    expect(started).toEqual(['session-1', 'session-2'])
    expect(coordinator.list().map((record) => record.status)).toEqual(['running', 'running'])

    gates.forEach((gate) => gate.resolve())
    await flushTasks()
  })

  test('绑定 backend turn id、request id，并持久化后台任务快照', async () => {
    const repository = new InMemoryTurnRunRepository()
    const coordinator = new PerTurnCoordinator({ repository })
    const gate = deferred()

    coordinator.enqueue({
      id: 'public-turn',
      sessionId: 'session-1',
      backend: 'claude',
      run: async (sink) => {
        sink.publish({ type: 'turn_started', turnId: 'backend-turn', sessionId: 'session-1' })
        sink.publish({
          type: 'approval_requested',
          turnId: 'backend-turn',
          requestId: 'approval-1',
          request: {
            kind: 'mcp',
            title: '允许工具',
            detail: 'detail',
            riskLevel: 'low',
          },
        })
        sink.publish({
          type: 'background_task_updated',
          turnId: 'backend-turn',
          task: {
            taskId: 'agent-a',
            toolUseId: 'tool-a',
            status: 'running',
            stats: { agentId: 'agent-a', status: 'running' },
          },
        })
        await gate.promise
        sink.publish({ type: 'turn_completed', turnId: 'backend-turn', status: 'completed' })
      },
      interrupt: vi.fn(async () => {}),
      onEvent: vi.fn(),
    })

    expect(coordinator.findBackend('public-turn')).toBe('claude')
    expect(coordinator.findBackend('backend-turn')).toBe('claude')
    expect(coordinator.findBackendByRequestId('approval-1')).toBe('claude')
    expect(coordinator.getBackendTurnId('public-turn')).toBe('backend-turn')
    expect(repository.list()[0]?.backgroundTasks).toEqual([
      expect.objectContaining({ taskId: 'agent-a', status: 'running' }),
    ])

    gate.resolve()
    await flushTasks()
  })

  test('idle watchdog 中断 backend，宽限期后保证 interrupted 终态', async () => {
    vi.useFakeTimers()
    const events: TurnEvent[] = []
    const interrupt = vi.fn(async () => {})
    const never = deferred()
    const coordinator = new PerTurnCoordinator({
      idleTimeoutMs: 100,
      cancelGraceMs: 50,
    })

    coordinator.enqueue({
      id: 'turn-timeout',
      sessionId: 'session-1',
      backend: 'claude',
      run: async (sink) => {
        sink.publish({
          type: 'turn_started',
          turnId: 'backend-timeout',
          sessionId: 'session-1',
        })
        await never.promise
      },
      interrupt,
      onEvent: (event) => events.push(event),
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(interrupt).toHaveBeenCalledWith('backend-timeout')
    expect(coordinator.list()[0]?.status).toBe('cancelling')

    await vi.advanceTimersByTimeAsync(50)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'error', recoverable: false }),
        expect.objectContaining({ type: 'turn_completed', status: 'interrupted' }),
      ]),
    )
    expect(coordinator.list()[0]?.status).toBe('interrupted')
  })

  test('取消排队中的 turn 不会启动 backend', async () => {
    const coordinator = new PerTurnCoordinator()
    const activeGate = deferred()
    const queuedRun = vi.fn(async () => {})
    const queuedEvents: TurnEvent[] = []

    coordinator.enqueue({
      id: 'active',
      sessionId: 'session-1',
      backend: 'claude',
      run: async (sink) => {
        sink.publish({ type: 'turn_started', turnId: 'backend-active', sessionId: 'session-1' })
        await activeGate.promise
        sink.publish({ type: 'turn_completed', turnId: 'backend-active', status: 'completed' })
      },
      interrupt: vi.fn(async () => {}),
      onEvent: vi.fn(),
    })
    coordinator.enqueue({
      id: 'queued',
      sessionId: 'session-1',
      backend: 'claude',
      run: queuedRun,
      interrupt: vi.fn(async () => {}),
      onEvent: (event) => queuedEvents.push(event),
    })

    expect(await coordinator.interrupt('queued')).toBe(true)
    expect(queuedRun).not.toHaveBeenCalled()
    expect(queuedEvents).toEqual([
      expect.objectContaining({ type: 'turn_completed', status: 'interrupted' }),
    ])
    expect(coordinator.list().find((record) => record.id === 'queued')?.backendTurnId).toBeNull()

    activeGate.resolve()
    await flushTasks()
  })

  test('首个事件前取消，绑定 backend turn id 后补发 interrupt', async () => {
    const coordinator = new PerTurnCoordinator({ cancelGraceMs: 10_000 })
    const beforeFirstEvent = deferred()
    const afterFirstEvent = deferred()
    const interrupt = vi.fn(async () => {})
    const pendingAction = vi.fn(async () => {})

    coordinator.enqueue({
      id: 'client-turn',
      sessionId: 'session-1',
      backend: 'claude',
      run: async (sink) => {
        await beforeFirstEvent.promise
        sink.publish({
          type: 'turn_started',
          turnId: 'backend-turn',
          sessionId: 'session-1',
        })
        await afterFirstEvent.promise
        sink.publish({
          type: 'turn_completed',
          turnId: 'backend-turn',
          status: 'interrupted',
        })
      },
      interrupt,
      onEvent: vi.fn(),
    })

    expect(coordinator.dispatchWhenBound('client-turn', pendingAction)).toBe(true)
    expect(await coordinator.interrupt('client-turn')).toBe(true)
    expect(interrupt).not.toHaveBeenCalled()

    beforeFirstEvent.resolve()
    await flushTasks()
    expect(interrupt).toHaveBeenCalledOnce()
    expect(interrupt).toHaveBeenCalledWith('backend-turn')
    expect(pendingAction).not.toHaveBeenCalled()

    afterFirstEvent.resolve()
    await flushTasks()
    expect(coordinator.list()[0]?.status).toBe('interrupted')
  })

  test('turn_completed 立即释放 lane，不依赖 backend iterator return', async () => {
    const coordinator = new PerTurnCoordinator()
    const stuckCleanup = deferred()
    const secondRun = vi.fn(async (sink) => {
      sink.publish({ type: 'turn_started', turnId: 'backend-2', sessionId: 'session-1' })
      sink.publish({ type: 'turn_completed', turnId: 'backend-2', status: 'completed' })
    })

    coordinator.enqueue({
      id: 'turn-1',
      sessionId: 'session-1',
      backend: 'claude',
      run: async (sink) => {
        sink.publish({ type: 'turn_started', turnId: 'backend-1', sessionId: 'session-1' })
        sink.publish({ type: 'turn_completed', turnId: 'backend-1', status: 'completed' })
        await stuckCleanup.promise
      },
      interrupt: vi.fn(async () => {}),
      onEvent: vi.fn(),
    })
    coordinator.enqueue({
      id: 'turn-2',
      sessionId: 'session-1',
      backend: 'claude',
      run: secondRun,
      interrupt: vi.fn(async () => {}),
      onEvent: vi.fn(),
    })

    await flushTasks()
    expect(secondRun).toHaveBeenCalledOnce()
    expect(coordinator.list().every((record) => record.status === 'completed')).toBe(true)

    stuckCleanup.resolve()
    await flushTasks()
  })

  test('取消中的 backend completed 统一投影为 interrupted', async () => {
    const coordinator = new PerTurnCoordinator()
    const complete = deferred()
    const events: TurnEvent[] = []

    coordinator.enqueue({
      id: 'turn-cancelling',
      sessionId: 'session-1',
      backend: 'claude',
      run: async (sink) => {
        sink.publish({ type: 'turn_started', turnId: 'backend-turn', sessionId: 'session-1' })
        await complete.promise
        sink.publish({ type: 'turn_completed', turnId: 'backend-turn', status: 'completed' })
      },
      interrupt: vi.fn(async () => {}),
      onEvent: (event) => events.push(event),
    })

    expect(await coordinator.interrupt('turn-cancelling')).toBe(true)
    complete.resolve()
    await flushTasks()

    expect(events.filter((event) => event.type === 'turn_completed')).toEqual([
      expect.objectContaining({ status: 'interrupted' }),
    ])
    expect(coordinator.list()[0]?.status).toBe('interrupted')
  })

  test('启动恢复把遗留非终态记录推进 interrupted', () => {
    const repository = new InMemoryTurnRunRepository()
    const stale: TurnRunRecord = {
      id: 'stale-turn',
      sessionId: 'session-1',
      backend: 'claude',
      backendTurnId: 'backend-stale',
      status: 'running',
      backgroundTasks: [
        {
          taskId: 'agent-a',
          status: 'running',
          stats: { agentId: 'agent-a', status: 'running' },
        },
      ],
      createdAt: 10,
      startedAt: 20,
      lastEventAt: 30,
      completedAt: null,
      error: null,
    }
    repository.save(stale)
    const coordinator = new PerTurnCoordinator({ repository, now: () => 100 })

    expect(coordinator.recoverInterrupted()).toEqual([
      expect.objectContaining({
        id: 'stale-turn',
        status: 'interrupted',
        completedAt: 100,
        backgroundTasks: [
          expect.objectContaining({
            taskId: 'agent-a',
            status: 'stopped',
            stats: expect.objectContaining({ status: 'stopped' }),
          }),
        ],
      }),
    ])
    expect(repository.list()[0]).toMatchObject({
      status: 'interrupted',
      error: '应用重启，后台任务已失去运行进程',
    })
  })

  test('backend 抛错时补齐 error 和唯一 turn_completed', async () => {
    const events: TurnEvent[] = []
    const coordinator = new PerTurnCoordinator()

    coordinator.enqueue({
      id: 'turn-error',
      sessionId: 'session-1',
      backend: 'claude',
      run: async () => {
        throw new Error('boom')
      },
      interrupt: vi.fn(async () => {}),
      onEvent: (event) => events.push(event),
    })
    await flushTasks()

    expect(events.filter((event) => event.type === 'error')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'turn_completed')).toEqual([
      expect.objectContaining({ status: 'error' }),
    ])
    expect(coordinator.list()[0]?.status).toBe('error')
  })
})
