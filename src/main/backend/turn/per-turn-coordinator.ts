import type { TurnEvent } from '@shared/backend/types'
import type { BackendId } from '@shared/constants'
import type { TurnRunRecord, TurnRunStatus } from '@shared/domain'

import { InMemoryTurnRunRepository, type TurnRunRepository } from './turn-run-repository'

export const DEFAULT_TURN_IDLE_TIMEOUT_MS = 30 * 60 * 1000
export const DEFAULT_CANCEL_GRACE_MS = 15 * 1000
export const DEFAULT_TURN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const DEFAULT_CHECKPOINT_INTERVAL_MS = 1000

export interface TurnEventSink {
  publish(event: TurnEvent): void
}

export interface CoordinatedTurnRequest {
  id: string
  sessionId: string
  backend: BackendId
  run(sink: TurnEventSink): Promise<void>
  interrupt(backendTurnId: string): Promise<void>
  onEvent(event: TurnEvent): void
  onSettled?(record: TurnRunRecord): void | Promise<void>
}

export interface PerTurnCoordinatorOptions {
  repository?: TurnRunRepository
  idleTimeoutMs?: number
  cancelGraceMs?: number
  retentionMs?: number
  checkpointIntervalMs?: number
  now?: () => number
  onError?: (error: unknown) => void
}

interface SessionLane {
  active: TurnEntry | null
  queue: TurnEntry[]
}

interface TurnEntry {
  request: CoordinatedTurnRequest
  record: TurnRunRecord
  laneKey: string
  backgroundTasks: Map<string, TurnRunRecord['backgroundTasks'][number]>
  requestIds: Set<string>
  pendingBoundActions: Array<(backendTurnId: string) => void | Promise<void>>
  terminalSeen: boolean
  settled: boolean
  settlePromise: Promise<void> | null
  interruptDispatched: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
  cancelTimer: ReturnType<typeof setTimeout> | null
  checkpointTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Backend 无关的 per-turn 协调器。
 *
 * 它只管理 turn 生命周期，不解析 Claude/Codex 原始协议：
 * - 同 session 串行排队
 * - public id / backend turn id / request id 路由
 * - idle watchdog、协作式取消和强制终态兜底
 * - background_task_updated 快照持久化
 * - run 异常或漏发终态时保证恰好一个 turn_completed
 */
export class PerTurnCoordinator {
  private readonly repository: TurnRunRepository
  private readonly idleTimeoutMs: number
  private readonly cancelGraceMs: number
  private readonly retentionMs: number
  private readonly checkpointIntervalMs: number
  private readonly now: () => number
  private readonly onError: (error: unknown) => void
  private lanes = new Map<string, SessionLane>()
  private aliases = new Map<string, TurnEntry>()
  private requests = new Map<string, TurnEntry>()

  constructor(options: PerTurnCoordinatorOptions = {}) {
    this.repository = options.repository ?? new InMemoryTurnRunRepository()
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_TURN_IDLE_TIMEOUT_MS
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS
    this.retentionMs = options.retentionMs ?? DEFAULT_TURN_RETENTION_MS
    this.checkpointIntervalMs = options.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS
    this.now = options.now ?? Date.now
    this.onError = options.onError ?? (() => {})
  }

  enqueue(request: CoordinatedTurnRequest): TurnRunRecord {
    if (this.aliases.has(request.id)) {
      throw new Error(`turn "${request.id}" is already coordinated`)
    }
    const createdAt = this.now()
    const record: TurnRunRecord = {
      id: request.id,
      sessionId: request.sessionId,
      backend: request.backend,
      backendTurnId: null,
      status: 'queued',
      backgroundTasks: [],
      createdAt,
      startedAt: null,
      lastEventAt: null,
      completedAt: null,
      error: null,
    }
    const laneKey = request.sessionId
    const entry: TurnEntry = {
      request,
      record,
      laneKey,
      backgroundTasks: new Map(),
      requestIds: new Set(),
      pendingBoundActions: [],
      terminalSeen: false,
      settled: false,
      settlePromise: null,
      interruptDispatched: false,
      idleTimer: null,
      cancelTimer: null,
      checkpointTimer: null,
    }
    const lane = this.lanes.get(laneKey) ?? { active: null, queue: [] }
    this.lanes.set(laneKey, lane)
    lane.queue.push(entry)
    this.aliases.set(request.id, entry)
    this.persist(entry)
    this.startNext(laneKey)
    return this.snapshot(entry.record)
  }

  async interrupt(referenceId: string, reason = '用户停止任务'): Promise<boolean> {
    const entry = this.aliases.get(referenceId)
    if (!entry || entry.settled) return false
    await this.cancel(entry, reason)
    return true
  }

  findBackend(referenceId: string): BackendId | null {
    return this.aliases.get(referenceId)?.request.backend ?? null
  }

  findBackendByRequestId(requestId: string): BackendId | null {
    return this.requests.get(requestId)?.request.backend ?? null
  }

  getBackendTurnId(referenceId: string): string | null {
    return this.aliases.get(referenceId)?.record.backendTurnId ?? null
  }

  /**
   * 在 adapter 的真实 turn id 建立后执行控制动作。
   *
   * Manager 用它承载 steer / hot-swap 等命令，协调器不需要知道动作的协议含义。
   * 返回 false 表示 turn 已不存在或正在取消，调用方可决定是否走旧版兼容路径。
   */
  dispatchWhenBound(
    referenceId: string,
    action: (backendTurnId: string) => void | Promise<void>,
  ): boolean {
    const entry = this.aliases.get(referenceId)
    if (!entry || entry.settled || entry.terminalSeen || entry.record.status === 'cancelling') {
      return false
    }
    const backendTurnId = entry.record.backendTurnId
    if (backendTurnId) {
      this.runBoundAction(action, backendTurnId)
    } else {
      entry.pendingBoundActions.push(action)
    }
    return true
  }

  list(sessionId?: string): TurnRunRecord[] {
    return this.repository.list(sessionId)
  }

  /**
   * App 重启时本地 SDK 进程已不存在，无法安全重连。
   * 将持久化的非终态记录推进 interrupted，保留任务快照供诊断/UI 回放。
   */
  recoverInterrupted(): TurnRunRecord[] {
    const recoveredAt = this.now()
    const recovered = this.repository.listRecoverable().map((record) => {
      const next: TurnRunRecord = {
        ...record,
        status: 'interrupted',
        backgroundTasks: record.backgroundTasks.map((task) => {
          if (task.status !== 'running') return task
          return {
            ...task,
            status: 'stopped',
            summary: '应用重启，后台任务已停止',
            stats: { ...task.stats, status: 'stopped' },
          }
        }),
        completedAt: recoveredAt,
        lastEventAt: record.lastEventAt ?? recoveredAt,
        error: '应用重启，后台任务已失去运行进程',
      }
      this.save(next)
      return this.snapshot(next)
    })
    this.prune()
    return recovered
  }

  prune(): number {
    return this.repository.pruneCompletedBefore(this.now() - this.retentionMs)
  }

  async dispose(): Promise<void> {
    const entries = new Set<TurnEntry>()
    for (const lane of this.lanes.values()) {
      if (lane.active) entries.add(lane.active)
      for (const entry of lane.queue) entries.add(entry)
    }

    const interrupts: Promise<void>[] = []
    const finishes: Promise<void>[] = []
    for (const entry of entries) {
      if (entry.settled) continue
      if (entry.record.status === 'running' || entry.record.status === 'cancelling') {
        const backendTurnId = entry.record.backendTurnId
        if (backendTurnId) {
          interrupts.push(entry.request.interrupt(backendTurnId).catch(this.onError))
        }
      }
      this.publishSyntheticCompletion(entry, 'interrupted')
      finishes.push(this.finish(entry))
    }
    await Promise.allSettled([...interrupts, ...finishes])
  }

  private startNext(laneKey: string): void {
    const lane = this.lanes.get(laneKey)
    if (!lane || lane.active) return
    const entry = lane.queue.shift()
    if (!entry) {
      this.lanes.delete(laneKey)
      return
    }
    if (entry.settled) {
      this.startNext(laneKey)
      return
    }

    lane.active = entry
    const startedAt = this.now()
    entry.record.status = 'running'
    entry.record.startedAt = startedAt
    entry.record.lastEventAt = startedAt
    this.persist(entry)
    this.armIdleWatchdog(entry)
    void this.execute(entry)
  }

  private async execute(entry: TurnEntry): Promise<void> {
    try {
      await entry.request.run({
        publish: (event) => this.publish(entry, event),
      })
      if (entry.settled) return
      if (!entry.terminalSeen) {
        if (entry.record.status === 'cancelling') {
          this.publishSyntheticCompletion(entry, 'interrupted')
        } else {
          this.publishSyntheticError(entry, 'Backend stream ended without turn_completed')
          this.publishSyntheticCompletion(entry, 'error')
        }
      }
      await this.finish(entry)
    } catch (error) {
      if (entry.settled) return
      if (entry.record.status === 'cancelling') {
        this.publishSyntheticCompletion(entry, 'interrupted')
      } else {
        const message = error instanceof Error ? error.message : String(error)
        this.publishSyntheticError(entry, message)
        this.publishSyntheticCompletion(entry, 'error')
      }
      await this.finish(entry)
    }
  }

  private publish(entry: TurnEntry, event: TurnEvent, bindBackendTurnId = true): void {
    if (entry.settled || entry.terminalSeen) return
    const eventAt = this.now()
    entry.record.lastEventAt = eventAt
    const publishedEvent =
      event.type === 'turn_completed' &&
      entry.record.status === 'cancelling' &&
      event.status === 'completed'
        ? { ...event, status: 'interrupted' as const }
        : event

    if (bindBackendTurnId && !entry.record.backendTurnId) {
      entry.record.backendTurnId = publishedEvent.turnId
      this.aliases.set(publishedEvent.turnId, entry)
      if (entry.record.status === 'cancelling') void this.dispatchInterrupt(entry)
      if (entry.record.status !== 'cancelling' && publishedEvent.type !== 'turn_completed') {
        const actions = entry.pendingBoundActions.splice(0)
        for (const action of actions) this.runBoundAction(action, publishedEvent.turnId)
      }
    }

    if (publishedEvent.type === 'background_task_updated') {
      entry.backgroundTasks.set(publishedEvent.task.taskId, structuredClone(publishedEvent.task))
      entry.record.backgroundTasks = [...entry.backgroundTasks.values()]
    } else if (
      publishedEvent.type === 'approval_requested' ||
      publishedEvent.type === 'agent_question'
    ) {
      entry.requestIds.add(publishedEvent.requestId)
      this.requests.set(publishedEvent.requestId, entry)
    } else if (publishedEvent.type === 'error' && !publishedEvent.recoverable) {
      entry.record.error = publishedEvent.message
    }

    if (publishedEvent.type === 'turn_completed') {
      entry.terminalSeen = true
      entry.record.status = publishedEvent.status
      entry.record.completedAt = eventAt
      this.clearTimer(entry, 'idle')
      this.clearTimer(entry, 'cancel')
      this.clearCheckpoint(entry)
    } else {
      this.armIdleWatchdog(entry)
    }

    if (
      publishedEvent.type === 'turn_started' ||
      publishedEvent.type === 'background_task_updated' ||
      publishedEvent.type === 'approval_requested' ||
      publishedEvent.type === 'agent_question' ||
      publishedEvent.type === 'error' ||
      publishedEvent.type === 'turn_completed'
    ) {
      this.persist(entry)
    } else {
      this.scheduleCheckpoint(entry)
    }
    this.emit(entry, publishedEvent)
    // 终态事件本身就是 lane 的完成边界，不能继续依赖 adapter iterator 正常 return。
    // adapter 若在协议清理阶段卡住，也不能阻塞同 session 的下一个 turn。
    if (publishedEvent.type === 'turn_completed') void this.finish(entry)
  }

  private async cancel(entry: TurnEntry, reason: string): Promise<void> {
    if (entry.record.status === 'queued') {
      entry.record.error = reason
      this.publishSyntheticCompletion(entry, 'interrupted')
      await this.finish(entry)
      return
    }
    if (entry.record.status !== 'running' && entry.record.status !== 'cancelling') return

    entry.record.status = 'cancelling'
    entry.record.error = reason
    entry.pendingBoundActions.length = 0
    this.persist(entry)
    this.clearTimer(entry, 'idle')
    this.armCancelGrace(entry)
    void this.dispatchInterrupt(entry)
  }

  private async dispatchInterrupt(entry: TurnEntry): Promise<void> {
    if (entry.interruptDispatched || entry.settled) return
    const backendTurnId = entry.record.backendTurnId
    if (!backendTurnId) return
    entry.interruptDispatched = true
    try {
      await entry.request.interrupt(backendTurnId)
    } catch (error) {
      this.onError(error)
    }
  }

  private armIdleWatchdog(entry: TurnEntry): void {
    if (entry.terminalSeen || entry.settled || entry.record.status !== 'running') return
    this.clearTimer(entry, 'idle')
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null
      if (entry.settled || entry.terminalSeen || entry.record.status !== 'running') return
      this.publishSyntheticError(
        entry,
        `Turn produced no events for ${this.idleTimeoutMs}ms; stopping background work`,
      )
      void this.cancel(entry, '后台任务长时间无事件，已自动停止')
    }, this.idleTimeoutMs)
    entry.idleTimer.unref?.()
  }

  private armCancelGrace(entry: TurnEntry): void {
    this.clearTimer(entry, 'cancel')
    entry.cancelTimer = setTimeout(() => {
      entry.cancelTimer = null
      if (entry.settled || entry.terminalSeen) return
      this.publishSyntheticCompletion(entry, 'interrupted')
      void this.finish(entry)
    }, this.cancelGraceMs)
    entry.cancelTimer.unref?.()
  }

  private publishSyntheticError(entry: TurnEntry, message: string): void {
    this.publish(
      entry,
      {
        type: 'error',
        turnId: entry.record.backendTurnId ?? entry.record.id,
        message,
        recoverable: false,
      },
      false,
    )
  }

  private publishSyntheticCompletion(
    entry: TurnEntry,
    status: Extract<TurnRunStatus, 'completed' | 'interrupted' | 'error'>,
  ): void {
    this.publish(
      entry,
      {
        type: 'turn_completed',
        turnId: entry.record.backendTurnId ?? entry.record.id,
        status,
      },
      false,
    )
  }

  private finish(entry: TurnEntry): Promise<void> {
    if (entry.settlePromise) return entry.settlePromise
    entry.settled = true
    entry.settlePromise = this.finishOnce(entry)
    return entry.settlePromise
  }

  private async finishOnce(entry: TurnEntry): Promise<void> {
    this.clearTimer(entry, 'idle')
    this.clearTimer(entry, 'cancel')
    this.clearCheckpoint(entry)
    if (!entry.record.completedAt) entry.record.completedAt = this.now()
    this.persist(entry)

    this.aliases.delete(entry.record.id)
    if (entry.record.backendTurnId) this.aliases.delete(entry.record.backendTurnId)
    for (const requestId of entry.requestIds) this.requests.delete(requestId)
    entry.pendingBoundActions.length = 0

    const lane = this.lanes.get(entry.laneKey)
    if (lane) {
      if (lane.active === entry) lane.active = null
      lane.queue = lane.queue.filter((queued) => queued !== entry)
      queueMicrotask(() => this.startNext(entry.laneKey))
    }

    try {
      await entry.request.onSettled?.(this.snapshot(entry.record))
    } catch (error) {
      this.onError(error)
    }
  }

  private emit(entry: TurnEntry, event: TurnEvent): void {
    try {
      entry.request.onEvent(event)
    } catch (error) {
      this.onError(error)
    }
  }

  private runBoundAction(
    action: (backendTurnId: string) => void | Promise<void>,
    backendTurnId: string,
  ): void {
    try {
      void Promise.resolve(action(backendTurnId)).catch(this.onError)
    } catch (error) {
      this.onError(error)
    }
  }

  private persist(entry: TurnEntry): void {
    this.save(entry.record)
  }

  private save(record: TurnRunRecord): void {
    try {
      this.repository.save(this.snapshot(record))
    } catch (error) {
      this.onError(error)
    }
  }

  private snapshot(record: TurnRunRecord): TurnRunRecord {
    return structuredClone(record)
  }

  private scheduleCheckpoint(entry: TurnEntry): void {
    if (entry.checkpointTimer || entry.settled) return
    entry.checkpointTimer = setTimeout(() => {
      entry.checkpointTimer = null
      if (!entry.settled) this.persist(entry)
    }, this.checkpointIntervalMs)
    entry.checkpointTimer.unref?.()
  }

  private clearCheckpoint(entry: TurnEntry): void {
    if (entry.checkpointTimer) clearTimeout(entry.checkpointTimer)
    entry.checkpointTimer = null
  }

  private clearTimer(entry: TurnEntry, timer: 'idle' | 'cancel'): void {
    const handle = timer === 'idle' ? entry.idleTimer : entry.cancelTimer
    if (handle) clearTimeout(handle)
    if (timer === 'idle') entry.idleTimer = null
    else entry.cancelTimer = null
  }
}
