import type {
  SDKBackgroundTasksChangedMessage,
  SDKResultMessage,
  SDKTaskNotificationMessage,
  SDKTaskStartedMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { ClaudeBackgroundTaskState } from '@main/backend/claude/background-task-state'
import { sdkUserToolResultToEvents } from '@main/backend/claude/sdk-mapping'
import { describe, expect, test } from 'vitest'

function result(
  uuid: string,
  options: {
    error?: boolean
    origin?: 'human' | 'task-notification'
    inputTokens?: number
    outputTokens?: number
    costUsd?: number
  } = {},
): SDKResultMessage {
  return {
    type: 'result',
    subtype: options.error ? 'error_during_execution' : 'success',
    is_error: options.error ?? false,
    uuid,
    usage: {
      input_tokens: options.inputTokens ?? 1,
      output_tokens: options.outputTokens ?? 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: {},
      service_tier: 'standard',
    },
    total_cost_usd: options.costUsd ?? 0.01,
    ...(options.origin ? { origin: { kind: options.origin } } : {}),
  } as unknown as SDKResultMessage
}

function taskStarted(taskId: string, toolUseId: string): SDKTaskStartedMessage {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: toolUseId,
    description: `分析 ${taskId}`,
    uuid: `start-${taskId}`,
    session_id: 'session-1',
  } as unknown as SDKTaskStartedMessage
}

function backgroundTasks(taskIds: string[]): SDKBackgroundTasksChangedMessage {
  return {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: taskIds.map((taskId) => ({
      task_id: taskId,
      task_type: 'local_agent',
      description: `分析 ${taskId}`,
    })),
    uuid: `membership-${taskIds.join('-')}`,
    session_id: 'session-1',
  } as unknown as SDKBackgroundTasksChangedMessage
}

function taskNotification(
  taskId: string,
  toolUseId: string,
  status: 'completed' | 'failed' | 'stopped' = 'completed',
): SDKTaskNotificationMessage {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    tool_use_id: toolUseId,
    status,
    output_file: `/tmp/${taskId}.txt`,
    summary: `${taskId} ${status}`,
    usage: { total_tokens: 100, tool_uses: 3, duration_ms: 2_000 },
    uuid: `notification-${taskId}-${status}`,
    session_id: 'session-1',
  } as unknown as SDKTaskNotificationMessage
}

function asyncLaunchMessage(taskId: string, toolUseId: string): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'Agent launched successfully',
        },
      ],
    },
    parent_tool_use_id: null,
    tool_use_result: {
      status: 'async_launched',
      isAsync: true,
      agentId: taskId,
      description: `分析 ${taskId}`,
    },
  }
}

describe('ClaudeBackgroundTaskState', () => {
  test('普通 turn 的首个 result 直接结束', () => {
    const state = new ClaudeBackgroundTaskState()

    expect(state.classifyResult(result('result-1'))).toBe('terminal')
  })

  test('并行 Agent 全部通知完成且汇总回合结束后才终止', () => {
    const state = new ClaudeBackgroundTaskState()
    state.handle(backgroundTasks(['agent-a', 'agent-b']))
    state.handle(taskStarted('agent-a', 'tool-a'))
    state.handle(taskStarted('agent-b', 'tool-b'))

    expect(state.classifyResult(result('initial-result', { origin: 'human' }))).toBe('intermediate')

    const firstUpdate = state.handle(taskNotification('agent-a', 'tool-a'))[0]
    expect(firstUpdate).toMatchObject({
      taskId: 'agent-a',
      toolUseId: 'tool-a',
      status: 'completed',
      stats: { status: 'completed', totalTokens: 100 },
    })
    expect(state.classifyResult(result('first-followup', { origin: 'task-notification' }))).toBe(
      'intermediate',
    )

    state.handle(taskNotification('agent-b', 'tool-b'))
    expect(state.classifyResult(result('final-followup', { origin: 'task-notification' }))).toBe(
      'terminal',
    )
  })

  test('任务在首个 result 前已完成时，仍保留后续自动汇总回合', () => {
    const state = new ClaudeBackgroundTaskState()
    state.handle(taskStarted('agent-fast', 'tool-fast'))
    state.handle(backgroundTasks([]))
    state.handle(taskNotification('agent-fast', 'tool-fast'))

    expect(state.classifyResult(result('initial-result'))).toBe('intermediate')
    expect(
      state.classifyResult(result('notification-followup', { origin: 'task-notification' })),
    ).toBe('terminal')
  })

  test('只收到 async_launched 也能识别后台任务，不依赖 system 事件顺序', () => {
    const state = new ClaudeBackgroundTaskState()

    expect(state.handleUserMessage(asyncLaunchMessage('agent-a', 'tool-a'))).toEqual([
      expect.objectContaining({
        taskId: 'agent-a',
        toolUseId: 'tool-a',
        status: 'running',
      }),
    ])
    expect(state.classifyResult(result('initial-result'))).toBe('intermediate')
  })

  test('全量集合移除任务时解除 running，漏收 notification 也不会卡死', () => {
    const state = new ClaudeBackgroundTaskState()
    state.handle(backgroundTasks(['agent-a']))
    state.handle(taskStarted('agent-a', 'tool-a'))
    expect(state.classifyResult(result('initial-result'))).toBe('intermediate')

    expect(state.handle(backgroundTasks([]))).toEqual([
      expect.objectContaining({
        taskId: 'agent-a',
        status: 'completed',
        summary: '后台任务已结束',
      }),
    ])
    expect(state.classifyResult(result('followup-result', { origin: 'task-notification' }))).toBe(
      'terminal',
    )
  })

  test('取消会把运行任务统一推进 stopped，并让下个 result 成为终态', () => {
    const state = new ClaudeBackgroundTaskState()
    state.handle(taskStarted('agent-a', 'tool-a'))

    expect(state.markCancelling()).toEqual([
      expect.objectContaining({
        taskId: 'agent-a',
        status: 'stopped',
        stats: expect.objectContaining({ status: 'stopped' }),
      }),
    ])
    expect(state.activeTaskIds()).toEqual([])
    expect(state.classifyResult(result('cancel-result'))).toBe('terminal')
  })

  test('累计所有模型回合的 token 和费用', () => {
    const state = new ClaudeBackgroundTaskState()
    state.handle(taskStarted('agent-a', 'tool-a'))
    state.classifyResult(
      result('initial-result', { inputTokens: 2, outputTokens: 3, costUsd: 0.1 }),
    )
    state.handle(taskNotification('agent-a', 'tool-a'))
    state.classifyResult(
      result('final-result', {
        origin: 'task-notification',
        inputTokens: 5,
        outputTokens: 7,
        costUsd: 0.2,
      }),
    )

    expect(state.accumulatedUsage()).toEqual({
      inputTokens: 7,
      outputTokens: 10,
      cacheReadTokens: 0,
      costUsd: 0.30000000000000004,
    })
  })
})

describe('sdkUserToolResultToEvents', () => {
  test('async_launched 只是后台启动确认，不提前完成 Agent 工具卡片', () => {
    expect([
      ...sdkUserToolResultToEvents(asyncLaunchMessage('agent-a', 'tool-a'), 'turn-1'),
    ]).toEqual([])
  })
})
