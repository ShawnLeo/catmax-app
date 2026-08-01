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
  SDKTaskUpdatedMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { BackgroundTaskSnapshot, TokenUsage, ToolTaskStats } from '@shared/backend/types'

import { stripHarnessEnvelope } from './mapping'

type TaskMessage =
  | SDKBackgroundTasksChangedMessage
  | SDKTaskNotificationMessage
  | SDKTaskProgressMessage
  | SDKTaskStartedMessage
  | SDKTaskUpdatedMessage

/**
 * 从后台 Bash 的 tool_result 文本里捞出输出文件路径。
 *
 * SDK 只在终态的 task_notification 上给 output_file，可 shell 任务恰恰是在运行中
 * 才需要它（`pnpm dist:mac` 跑五分钟，期间面板要能 tail 输出）。启动时的
 * tool_result 文本里已经有同一个路径，这里是唯一能提前拿到它的地方。
 */
export function parseBackgroundOutputFile(text: string): string | undefined {
  const match = /Output is being written to:\s*(\S+?\.output)/.exec(text)
  return match?.[1]
}

/**
 * 归一化 SDK 给的任务摘要。
 *
 * 子 Agent 的 task_notification.summary 装的是回传给上层模型的整份产出，开头
 * 常常带 harness 的信封说明（"输出匹配到指令形状，控制标签已中和…"）。那是
 * 写给模型的免疫声明，直接进快照就会在后台面板顶部糊上一大段方括号噪音。
 */
function normalizeSummary(summary: string | undefined): string | undefined {
  if (!summary) return undefined
  return stripHarnessEnvelope(summary).trim() || undefined
}

/** task_updated 的 status 取值比快照多，收敛到快照的 4 态。 */
function normalizeUpdatedStatus(
  status: NonNullable<SDKTaskUpdatedMessage['patch']['status']>,
): BackgroundTaskSnapshot['status'] {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'killed':
      return 'stopped'
    // pending / paused 都还在生命周期内，对 UI 而言仍是"没结束"。
    default:
      return 'running'
  }
}

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
      case 'task_updated':
        return this.handleUpdated(message)
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
    // 后台 Bash（run_in_background）走的是另一条路：tool_use_result 上只有
    // backgroundTaskId，既没有 async_launched 也没有 isAsync。漏掉它，shell 任务
    // 就只能等 task_started 才进表，而且永远拿不到 outputFile——面板也就没有输出可 tail。
    const backgroundTaskId =
      typeof result.backgroundTaskId === 'string' ? result.backgroundTaskId : undefined
    if (!isAsyncLaunch && !backgroundTaskId) return []

    const taskId =
      backgroundTaskId ??
      (typeof result.agentId === 'string'
        ? result.agentId
        : typeof result.taskId === 'string'
          ? result.taskId
          : undefined)
    if (!taskId) return []

    const toolUseId = this.findToolUseId(message)
    const existing = this.tasks.get(taskId)
    const description =
      typeof result.description === 'string' ? result.description : existing?.snapshot.description
    const outputFile =
      (backgroundTaskId
        ? parseBackgroundOutputFile(this.findToolResultText(message))
        : undefined) ?? existing?.snapshot.outputFile
    const snapshot: BackgroundTaskSnapshot = {
      taskId,
      ...(toolUseId
        ? { toolUseId }
        : existing?.snapshot.toolUseId
          ? { toolUseId: existing.snapshot.toolUseId }
          : {}),
      status: 'running',
      ...(description ? { description } : {}),
      ...(backgroundTaskId
        ? { taskType: 'shell' }
        : existing?.snapshot.taskType
          ? { taskType: existing.snapshot.taskType }
          : {}),
      ...(outputFile ? { outputFile } : {}),
      startedAt: existing?.snapshot.startedAt ?? Date.now(),
      stats: {
        ...(existing?.snapshot.stats ?? {}),
        // shell 任务没有 agent，agentId 会被 TaskCard 误当成"可展开子会话"。
        ...(backgroundTaskId ? {} : { agentId: taskId }),
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
        if (task.task_type) existing.snapshot.taskType = task.task_type
        existing.snapshot.startedAt ??= Date.now()
        existing.snapshot.stats.status = 'running'
        updates.push(this.copy(existing.snapshot))
        continue
      }
      const snapshot: BackgroundTaskSnapshot = {
        taskId: task.task_id,
        status: 'running',
        description: task.description,
        ...(task.task_type ? { taskType: task.task_type } : {}),
        startedAt: Date.now(),
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
      ...(message.task_type
        ? { taskType: message.task_type }
        : message.subagent_type
          ? { taskType: 'subagent' }
          : previous?.snapshot.taskType
            ? { taskType: previous.snapshot.taskType }
            : {}),
      ...(previous?.snapshot.outputFile ? { outputFile: previous.snapshot.outputFile } : {}),
      startedAt: Date.now(),
      stats,
    }
    this.tasks.set(message.task_id, { snapshot, attempt })
    return this.copy(snapshot)
  }

  /**
   * task_updated 是 patch 语义：只带变化的字段，客户端合并进本地表。
   * 它是 SDK 唯一给出 error 原文和 killed/paused 状态的地方。
   */
  private handleUpdated(message: SDKTaskUpdatedMessage): BackgroundTaskSnapshot[] {
    const existing = this.tasks.get(message.task_id)
    if (!existing) return []
    this.sawBackgroundTask = true
    const { patch } = message
    const snapshot = existing.snapshot
    if (patch.description) snapshot.description = patch.description
    if (patch.error) snapshot.error = patch.error
    if (patch.status) {
      const status = normalizeUpdatedStatus(patch.status)
      snapshot.status = status
      snapshot.stats.status = status
      if (status !== 'running') {
        this.liveTaskIds.delete(message.task_id)
        this.pendingNotificationFollowup = true
      }
    }
    return [this.copy(snapshot)]
  }

  private handleProgress(message: SDKTaskProgressMessage): BackgroundTaskSnapshot {
    this.sawBackgroundTask = true
    this.liveTaskIds.add(message.task_id)
    const existing = this.tasks.get(message.task_id)
    const summary = normalizeSummary(message.summary)
    const stats: ToolTaskStats = {
      ...(existing?.snapshot.stats ?? {}),
      agentId: message.task_id,
      status: 'running',
      totalDurationMs: message.usage.duration_ms,
      totalTokens: message.usage.total_tokens,
      totalToolUseCount: message.usage.tool_uses,
      ...(message.subagent_type ? { agentType: message.subagent_type } : {}),
      ...(summary ? { progressSummary: summary } : {}),
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
      ...(summary ? { summary } : {}),
      ...(message.subagent_type
        ? { taskType: 'subagent' }
        : existing?.snapshot.taskType
          ? { taskType: existing.snapshot.taskType }
          : {}),
      ...(existing?.snapshot.outputFile ? { outputFile: existing.snapshot.outputFile } : {}),
      startedAt: existing?.snapshot.startedAt ?? Date.now(),
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
    const summary = normalizeSummary(message.summary)
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
      ...(summary ? { summary } : {}),
      ...(existing?.snapshot.taskType ? { taskType: existing.snapshot.taskType } : {}),
      // 终态才拿到权威的 output_file；shell 任务运行期用的是启动时解析出来的那个。
      ...(message.output_file
        ? { outputFile: message.output_file }
        : existing?.snapshot.outputFile
          ? { outputFile: existing.snapshot.outputFile }
          : {}),
      ...(existing?.snapshot.startedAt ? { startedAt: existing.snapshot.startedAt } : {}),
      ...(existing?.snapshot.error ? { error: existing.snapshot.error } : {}),
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

  /** 拼出 user 消息里所有 tool_result 的文本，供解析后台 Bash 的输出文件路径。 */
  private findToolResultText(message: SDKUserMessage): string {
    const content = message.message.content
    if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
    const parts: string[] = []
    for (const block of content) {
      if (typeof block !== 'object' || block === null || block.type !== 'tool_result') continue
      const inner = block.content
      if (typeof inner === 'string') parts.push(inner)
      else if (Array.isArray(inner)) {
        for (const item of inner) {
          if (typeof item === 'object' && item !== null && item.type === 'text')
            parts.push(item.text)
        }
      }
    }
    return parts.join('\n')
  }

  private copy(snapshot: BackgroundTaskSnapshot): BackgroundTaskSnapshot {
    return { ...snapshot, stats: { ...snapshot.stats } }
  }
}
