/**
 * Claude 后台任务状态机。
 *
 * Claude Code 2.1.198+ 默认把 Agent 放到后台。此时首个 result 只是当前模型回合
 * 的边界；后台任务完成后，SDK 会发 task_notification，并自动触发后续汇总回合。
 * 只有所有任务终止且该通知对应的 follow-up result 到达，CatMax turn 才真正完成。
 */
import type {
  SDKBackgroundTasksChangedMessage,
  SDKResultMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { BackgroundTaskSnapshot, TokenUsage, ToolTaskStats } from '@shared/backend/types'

type TaskMessage =
  | SDKBackgroundTasksChangedMessage
  | SDKTaskNotificationMessage
  | SDKTaskProgressMessage
  | SDKTaskStartedMessage

interface InternalTask {
  snapshot: BackgroundTaskSnapshot
  attempt: number
}

export class ClaudeBackgroundTaskState {
  private tasks = new Map<string, InternalTask>()
  private liveTaskIds = new Set<string>()
  private seenNotificationUuids = new Set<string>()
  private sawBackgroundTask = false
  private initialResultSeen = false
  private pendingNotificationFollowup = false
  private cancelling = false
  private usage: TokenUsage = {}

  handle(message: TaskMessage): BackgroundTaskSnapshot[] {
    switch (message.subtype) {
      case 'background_tasks_changed':
        return this.handleMembership(message)
      case 'task_started':
        return [this.handleStarted(message)]
      case 'task_progress':
        return [this.handleProgress(message)]
      case 'task_notification':
        return this.handleNotification(message)
    }
  }

  handleUserMessage(message: SDKUserMessage): BackgroundTaskSnapshot[] {
    const toolUseResult = message.tool_use_result
    if (toolUseResult === null || typeof toolUseResult !== 'object') return []
    const result = toolUseResult as Record<string, unknown>
    const isAsyncLaunch =
      result.status === 'async_launched' ||
      result.status === 'remote_launched' ||
      result.isAsync === true
    if (!isAsyncLaunch) return []

    const taskId =
      typeof result.agentId === 'string'
        ? result.agentId
        : typeof result.taskId === 'string'
          ? result.taskId
          : undefined
    if (!taskId) return []

    const toolUseId = this.findToolUseId(message)
    const existing = this.tasks.get(taskId)
    const description =
      typeof result.description === 'string' ? result.description : existing?.snapshot.description
    const snapshot: BackgroundTaskSnapshot = {
      taskId,
      ...(toolUseId
        ? { toolUseId }
        : existing?.snapshot.toolUseId
          ? { toolUseId: existing.snapshot.toolUseId }
          : {}),
      status: 'running',
      ...(description ? { description } : {}),
      stats: {
        ...(existing?.snapshot.stats ?? {}),
        agentId: taskId,
        status: 'running',
      },
    }
    this.sawBackgroundTask = true
    this.liveTaskIds.add(taskId)
    this.tasks.set(taskId, { snapshot, attempt: existing?.attempt ?? 1 })
    return [this.copy(snapshot)]
  }

  classifyResult(message: SDKResultMessage): 'intermediate' | 'terminal' {
    this.accumulateUsage(message)
    if (message.is_error || this.cancelling) return 'terminal'
    if (!this.sawBackgroundTask) return 'terminal'

    // 后台 Agent 启动后的首个 result 属于原始用户回合，不能结束整个 CatMax turn。
    if (!this.initialResultSeen) {
      this.initialResultSeen = true
      return 'intermediate'
    }

    const allTerminal =
      this.tasks.size > 0 &&
      [...this.tasks.values()].every(({ snapshot }) => snapshot.status !== 'running')
    const isNotificationFollowup =
      message.origin?.kind === 'task-notification' || this.pendingNotificationFollowup

    if (this.liveTaskIds.size === 0 && allTerminal && isNotificationFollowup) {
      this.pendingNotificationFollowup = false
      return 'terminal'
    }

    // 某个任务的通知可能先触发一次汇总，但其他并行任务仍在运行。
    if (isNotificationFollowup) this.pendingNotificationFollowup = false
    return 'intermediate'
  }

  markCancelling(): BackgroundTaskSnapshot[] {
    this.cancelling = true
    this.liveTaskIds.clear()
    const updates: BackgroundTaskSnapshot[] = []
    for (const task of this.tasks.values()) {
      if (task.snapshot.status !== 'running') continue
      task.snapshot.status = 'stopped'
      task.snapshot.stats.status = 'stopped'
      task.snapshot.summary = '用户已停止任务'
      updates.push(this.copy(task.snapshot))
    }
    return updates
  }

  isCancelling(): boolean {
    return this.cancelling
  }

  activeTaskIds(): string[] {
    return [...this.liveTaskIds]
  }

  accumulatedUsage(): TokenUsage {
    return { ...this.usage }
  }

  private handleMembership(message: SDKBackgroundTasksChangedMessage): BackgroundTaskSnapshot[] {
    const previousLiveTaskIds = this.liveTaskIds
    const nextLiveTaskIds = new Set(message.tasks.map((task) => task.task_id))
    const updates: BackgroundTaskSnapshot[] = []
    this.liveTaskIds = nextLiveTaskIds
    if (message.tasks.length > 0) this.sawBackgroundTask = true

    // level 信号是全量替换语义。任务从集合中消失说明它已不再运行；
    // 即使漏收 task_notification，也不能让 turn 永久卡在 running。
    for (const taskId of previousLiveTaskIds) {
      if (nextLiveTaskIds.has(taskId)) continue
      const existing = this.tasks.get(taskId)
      if (!existing || existing.snapshot.status !== 'running') continue
      existing.snapshot.status = 'completed'
      existing.snapshot.summary = '后台任务已结束'
      existing.snapshot.stats.status = 'completed'
      updates.push(this.copy(existing.snapshot))
      this.pendingNotificationFollowup = true
    }

    for (const task of message.tasks) {
      const existing = this.tasks.get(task.task_id)
      if (existing) {
        existing.snapshot.status = 'running'
        existing.snapshot.description = task.description
        existing.snapshot.stats.status = 'running'
        updates.push(this.copy(existing.snapshot))
        continue
      }
      const snapshot: BackgroundTaskSnapshot = {
        taskId: task.task_id,
        status: 'running',
        description: task.description,
        stats: { agentId: task.task_id, status: 'running' },
      }
      this.tasks.set(task.task_id, { snapshot, attempt: 1 })
      updates.push(this.copy(snapshot))
    }
    return updates
  }

  private handleStarted(message: SDKTaskStartedMessage): BackgroundTaskSnapshot {
    this.sawBackgroundTask = true
    this.liveTaskIds.add(message.task_id)
    const previous = this.tasks.get(message.task_id)
    const attempt =
      previous && previous.snapshot.status !== 'running'
        ? previous.attempt + 1
        : (previous?.attempt ?? 1)
    const stats: ToolTaskStats = {
      agentId: message.task_id,
      status: 'running',
      ...(message.subagent_type ? { agentType: message.subagent_type } : {}),
    }
    const snapshot: BackgroundTaskSnapshot = {
      taskId: message.task_id,
      ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
      status: 'running',
      description: message.description,
      stats,
    }
    this.tasks.set(message.task_id, { snapshot, attempt })
    return this.copy(snapshot)
  }

  private handleProgress(message: SDKTaskProgressMessage): BackgroundTaskSnapshot {
    this.sawBackgroundTask = true
    this.liveTaskIds.add(message.task_id)
    const existing = this.tasks.get(message.task_id)
    const stats: ToolTaskStats = {
      ...(existing?.snapshot.stats ?? {}),
      agentId: message.task_id,
      status: 'running',
      totalDurationMs: message.usage.duration_ms,
      totalTokens: message.usage.total_tokens,
      totalToolUseCount: message.usage.tool_uses,
      ...(message.subagent_type ? { agentType: message.subagent_type } : {}),
      ...(message.summary ? { progressSummary: message.summary } : {}),
      ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
    }
    const snapshot: BackgroundTaskSnapshot = {
      taskId: message.task_id,
      ...(message.tool_use_id
        ? { toolUseId: message.tool_use_id }
        : existing?.snapshot.toolUseId
          ? { toolUseId: existing.snapshot.toolUseId }
          : {}),
      status: 'running',
      description: message.description,
      ...(message.summary ? { summary: message.summary } : {}),
      stats,
    }
    this.tasks.set(message.task_id, {
      snapshot,
      attempt: existing?.attempt ?? 1,
    })
    return this.copy(snapshot)
  }

  private handleNotification(message: SDKTaskNotificationMessage): BackgroundTaskSnapshot[] {
    if (this.seenNotificationUuids.has(message.uuid)) return []
    this.seenNotificationUuids.add(message.uuid)
    this.sawBackgroundTask = true
    this.liveTaskIds.delete(message.task_id)
    this.pendingNotificationFollowup = true

    const existing = this.tasks.get(message.task_id)
    const status = message.status
    const stats: ToolTaskStats = {
      ...(existing?.snapshot.stats ?? {}),
      agentId: message.task_id,
      status,
      ...(message.usage
        ? {
            totalDurationMs: message.usage.duration_ms,
            totalTokens: message.usage.total_tokens,
            totalToolUseCount: message.usage.tool_uses,
          }
        : {}),
    }
    const snapshot: BackgroundTaskSnapshot = {
      taskId: message.task_id,
      ...(message.tool_use_id
        ? { toolUseId: message.tool_use_id }
        : existing?.snapshot.toolUseId
          ? { toolUseId: existing.snapshot.toolUseId }
          : {}),
      status,
      ...(existing?.snapshot.description ? { description: existing.snapshot.description } : {}),
      summary: message.summary,
      stats,
    }
    this.tasks.set(message.task_id, {
      snapshot,
      attempt: existing?.attempt ?? 1,
    })
    return [this.copy(snapshot)]
  }

  private accumulateUsage(message: SDKResultMessage): void {
    this.usage.inputTokens = (this.usage.inputTokens ?? 0) + (message.usage.input_tokens ?? 0)
    this.usage.outputTokens = (this.usage.outputTokens ?? 0) + (message.usage.output_tokens ?? 0)
    this.usage.cacheReadTokens =
      (this.usage.cacheReadTokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0)
    this.usage.costUsd = (this.usage.costUsd ?? 0) + (message.total_cost_usd ?? 0)
  }

  private findToolUseId(message: SDKUserMessage): string | undefined {
    const content = message.message.content
    if (!Array.isArray(content)) return undefined
    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        block.type === 'tool_result' &&
        typeof block.tool_use_id === 'string'
      ) {
        return block.tool_use_id
      }
    }
    return undefined
  }

  private copy(snapshot: BackgroundTaskSnapshot): BackgroundTaskSnapshot {
    return { ...snapshot, stats: { ...snapshot.stats } }
  }
}
