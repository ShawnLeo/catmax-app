import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, test } from 'vitest'

import { useMessageStore } from './message'

describe('message store Codex activity streaming', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('相邻活动聚合，并原位更新实时 diff 与命令输出', () => {
    const store = useMessageStore()
    store.setCurrentSession('session-1')

    store.applyEvent('session-1', {
      type: 'content_block_upsert',
      turnId: 'turn-1',
      block: {
        id: 'cmd-1',
        type: 'codex_activity',
        status: 'running',
        activities: [
          {
            id: 'cmd-1',
            kind: 'command',
            command: 'pnpm test',
            status: 'running',
          },
        ],
      },
    })
    store.applyEvent('session-1', {
      type: 'codex_activity_output_delta',
      turnId: 'turn-1',
      itemId: 'cmd-1',
      text: 'running',
    })
    store.applyEvent('session-1', {
      type: 'content_block_upsert',
      turnId: 'turn-1',
      block: {
        id: 'patch-1',
        type: 'codex_activity',
        status: 'running',
        activities: [
          {
            id: 'patch-1',
            kind: 'file_change',
            status: 'running',
            changes: [
              {
                path: '/repo/a.ts',
                kind: 'update',
                diff: '@@ -1 +1 @@\n-old\n+new',
                stats: { additions: 1, deletions: 1 },
              },
            ],
          },
        ],
      },
    })
    store.applyEvent('session-1', {
      type: 'codex_turn_diff_updated',
      turnId: 'turn-1',
      diff: '--- a/a.ts\n+++ b/a.ts\n-old\n+new\n+next',
    })

    expect(store.messages).toHaveLength(1)
    const block = store.messages[0]?.blocks?.[0]
    expect(block?.type).toBe('codex_activity')
    if (block?.type === 'codex_activity') {
      expect(block.activities).toHaveLength(2)
      expect(block.activities[0]).toMatchObject({ output: 'running' })
      expect(block.turnDiffStats).toEqual({ additions: 2, deletions: 1 })
    }
  })

  test('commentary 文本会切断活动聚合区段', () => {
    const store = useMessageStore()
    store.setCurrentSession('session-1')
    const activity = (id: string) => ({
      type: 'content_block_upsert' as const,
      turnId: 'turn-1',
      block: {
        id,
        type: 'codex_activity' as const,
        status: 'completed' as const,
        activities: [{ id, kind: 'command' as const, command: id, status: 'completed' as const }],
      },
    })

    store.applyEvent('session-1', activity('one'))
    store.applyEvent('session-1', {
      type: 'text_delta',
      turnId: 'turn-1',
      itemId: 'commentary',
      text: '中间进度',
    })
    store.applyEvent('session-1', activity('two'))

    expect(store.messages).toHaveLength(3)
    expect(store.messages[0]?.blocks?.[0]?.type).toBe('codex_activity')
    expect(store.messages[1]?.blocks?.[0]?.type).toBe('text')
    expect(store.messages[2]?.blocks?.[0]?.type).toBe('codex_activity')
  })

  test('completed 文本快照和晚到 delta 聚合到同一消息且不重复正文', () => {
    const store = useMessageStore()
    store.setCurrentSession('session-1')

    store.applyEvent('session-1', {
      type: 'content_block_upsert',
      turnId: 'turn-1',
      itemId: 'message-1',
      completed: true,
      block: {
        id: 'message-1-text',
        type: 'text',
        text: '最终正文',
        phase: 'final_answer',
      },
    })
    store.applyEvent('session-1', {
      type: 'text_delta',
      turnId: 'turn-1',
      itemId: 'message-1',
      text: '最终正文',
    })

    expect(store.messages).toHaveLength(1)
    expect(store.messages[0]).toMatchObject({
      id: 'message-1',
      blocks: [
        {
          id: 'message-1-text',
          type: 'text',
          text: '最终正文',
          phase: 'final_answer',
        },
      ],
    })
  })

  test('先到 delta 后到 completed 时用最终快照覆盖流式文本', () => {
    const store = useMessageStore()
    store.setCurrentSession('session-1')

    store.applyEvent('session-1', {
      type: 'text_delta',
      turnId: 'turn-1',
      itemId: 'message-1',
      text: '最终',
    })
    store.applyEvent('session-1', {
      type: 'content_block_upsert',
      turnId: 'turn-1',
      itemId: 'message-1',
      completed: true,
      block: {
        id: 'message-1-text',
        type: 'text',
        text: '最终正文',
        phase: 'final_answer',
      },
    })
    store.applyEvent('session-1', {
      type: 'text_delta',
      turnId: 'turn-1',
      itemId: 'message-1',
      text: '正文',
    })

    expect(store.messages).toHaveLength(1)
    expect(store.messages[0]?.blocks?.[0]).toMatchObject({
      id: 'message-1-text',
      text: '最终正文',
      phase: 'final_answer',
    })
  })

  test('异步发送和历史加载始终写入指定 session，不污染当前页面', () => {
    const store = useMessageStore()
    store.setCurrentSession('session-2')

    store.pushUserMessageToSession('session-1', 'turn-1', '第一会话')
    store.setMessagesForSession('session-1', [
      {
        id: 'history-1',
        role: 'assistant',
        turnId: 'turn-1',
        blocks: [{ id: 'history-1-text', type: 'text', text: '第一会话回复' }],
        createdAt: 0,
      },
    ])

    expect(store.messages).toEqual([])
    store.setCurrentSession('session-1')
    expect(store.messages).toEqual([
      expect.objectContaining({
        id: 'history-1',
        blocks: [expect.objectContaining({ text: '第一会话回复' })],
      }),
    ])
  })
})

describe('message store Claude background tasks', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('后台 Agent 从 running 更新到 completed，并保留统计信息', () => {
    const store = useMessageStore()
    store.setCurrentSession('session-1')
    store.applyEvent('session-1', {
      type: 'tool_call_started',
      turnId: 'turn-1',
      itemId: 'tool-a',
      tool: {
        kind: 'task',
        title: 'Agent',
        task: {
          description: '分析代理层',
          prompt: '检查代理实现',
        },
      },
    })
    store.applyEvent('session-1', {
      type: 'background_task_updated',
      turnId: 'turn-1',
      task: {
        taskId: 'agent-a',
        toolUseId: 'tool-a',
        status: 'running',
        summary: '正在读取文件',
        stats: {
          agentId: 'agent-a',
          status: 'running',
          totalTokens: 50,
          progressSummary: '正在读取文件',
        },
      },
    })

    expect(store.messages[0]?.toolBlocks?.[0]).toMatchObject({
      id: 'tool-a',
      status: 'running',
      taskStats: {
        agentId: 'agent-a',
        status: 'running',
        progressSummary: '正在读取文件',
      },
    })

    store.applyEvent('session-1', {
      type: 'background_task_updated',
      turnId: 'turn-1',
      task: {
        taskId: 'agent-a',
        toolUseId: 'tool-a',
        status: 'completed',
        summary: '代理分析完成',
        stats: {
          agentId: 'agent-a',
          status: 'completed',
          totalTokens: 120,
          totalDurationMs: 2_000,
        },
      },
    })

    expect(store.messages[0]?.toolBlocks?.[0]).toMatchObject({
      status: 'completed',
      output: { ok: true, summary: '代理分析完成' },
      taskStats: {
        status: 'completed',
        totalTokens: 120,
        totalDurationMs: 2_000,
      },
    })
  })

  test('用户停止后台 Agent 时显示 stopped，而不是 completed', () => {
    const store = useMessageStore()
    store.setCurrentSession('session-1')
    store.applyEvent('session-1', {
      type: 'tool_call_started',
      turnId: 'turn-1',
      itemId: 'tool-a',
      tool: {
        kind: 'task',
        title: 'Agent',
        task: {
          description: '分析协议',
          prompt: '检查协议',
        },
      },
    })
    store.applyEvent('session-1', {
      type: 'background_task_updated',
      turnId: 'turn-1',
      task: {
        taskId: 'agent-a',
        toolUseId: 'tool-a',
        status: 'stopped',
        summary: '用户已停止任务',
        stats: { agentId: 'agent-a', status: 'stopped' },
      },
    })

    expect(store.messages[0]?.toolBlocks?.[0]).toMatchObject({
      status: 'failed',
      output: { ok: false, summary: '用户已停止任务' },
      taskStats: { status: 'stopped' },
    })
  })

  describe('后台任务全表', () => {
    test('没有 toolUseId 的任务也进表（level 信号不带它）', () => {
      const store = useMessageStore()
      store.setCurrentSession('session-1')
      // background_tasks_changed 只带 task_id，如果因为缺 toolUseId 就丢弃，
      // 面板和徽标将永远看不到这类任务。
      store.applyEvent('session-1', {
        type: 'background_task_updated',
        turnId: 'turn-1',
        task: {
          taskId: 'task-a',
          status: 'running',
          description: '打包 macOS 应用',
          stats: { status: 'running' },
        },
      })

      expect(store.backgroundTasks).toHaveLength(1)
      expect(store.backgroundTasks[0]).toMatchObject({ taskId: 'task-a', status: 'running' })
      expect(store.runningBackgroundTaskCount).toBe(1)
    })

    test('后续事件合并而非覆盖，已拿到的 outputFile 不被抹掉', () => {
      const store = useMessageStore()
      store.setCurrentSession('session-1')
      store.applyEvent('session-1', {
        type: 'background_task_updated',
        turnId: 'turn-1',
        task: {
          taskId: 'task-a',
          status: 'running',
          taskType: 'shell',
          outputFile: '/tmp/s/tasks/task-a.output',
          startedAt: 1000,
          stats: { status: 'running' },
        },
      })
      // 终态若不带 outputFile（例如来自 task_updated），面板不该因此失去输出。
      store.applyEvent('session-1', {
        type: 'background_task_updated',
        turnId: 'turn-1',
        task: {
          taskId: 'task-a',
          status: 'completed',
          summary: '打包完成',
          stats: { status: 'completed' },
        },
      })

      expect(store.backgroundTasks).toHaveLength(1)
      expect(store.backgroundTasks[0]).toMatchObject({
        status: 'completed',
        summary: '打包完成',
        taskType: 'shell',
        outputFile: '/tmp/s/tasks/task-a.output',
      })
      expect(store.runningBackgroundTaskCount).toBe(0)
    })

    test('运行中的排在已完成的前面', () => {
      const store = useMessageStore()
      store.setCurrentSession('session-1')
      store.applyEvent('session-1', {
        type: 'background_task_updated',
        turnId: 'turn-1',
        task: {
          taskId: 'done',
          status: 'completed',
          startedAt: 5000,
          stats: { status: 'completed' },
        },
      })
      store.applyEvent('session-1', {
        type: 'background_task_updated',
        turnId: 'turn-1',
        task: { taskId: 'live', status: 'running', startedAt: 1000, stats: { status: 'running' } },
      })

      expect(store.backgroundTasks.map((t) => t.taskId)).toEqual(['live', 'done'])
    })

    test('turn 因错误结束时清扫仍在运行的任务，徽标不会永远转圈', () => {
      const store = useMessageStore()
      store.setCurrentSession('session-1')
      store.applyEvent('session-1', {
        type: 'background_task_updated',
        turnId: 'turn-1',
        task: { taskId: 'task-a', status: 'running', stats: { status: 'running' } },
      })
      expect(store.runningBackgroundTaskCount).toBe(1)

      // error 结束会直接掐断 SDK query，任务不会再收到终态通知。
      store.applyEvent('session-1', {
        type: 'turn_completed',
        turnId: 'turn-1',
        status: 'error',
      })

      expect(store.runningBackgroundTaskCount).toBe(0)
      expect(store.backgroundTasks[0]).toMatchObject({ status: 'stopped' })
    })

    test('turn 正常结束不动任务状态', () => {
      const store = useMessageStore()
      store.setCurrentSession('session-1')
      store.applyEvent('session-1', {
        type: 'background_task_updated',
        turnId: 'turn-1',
        task: { taskId: 'task-a', status: 'completed', stats: { status: 'completed' } },
      })
      store.applyEvent('session-1', {
        type: 'turn_completed',
        turnId: 'turn-1',
        status: 'completed',
      })

      expect(store.backgroundTasks[0]).toMatchObject({ status: 'completed' })
    })

    test('子 Agent 实时消息挂到发起它的卡片下，不进主对话流', () => {
      const store = useMessageStore()
      store.setCurrentSession('session-1')
      store.applyEvent('session-1', {
        type: 'subagent_message',
        turnId: 'turn-1',
        parentToolUseId: 'tool-a',
        message: {
          id: 'sub-1',
          role: 'assistant',
          turnId: 'turn-1',
          textBlocks: [{ id: 'b1', text: '正在读取文件', kind: 'text' }],
          toolBlocks: [
            { id: 'sub-tool-1', info: { kind: 'other', title: 'Read' }, status: 'running' },
          ],
          createdAt: 0,
        },
      })

      // 主对话流必须干净——子 Agent 的内部过程不是用户发起的对话
      expect(store.messages).toHaveLength(0)
      expect(store.subagentMessagesFor('tool-a')).toHaveLength(1)
      expect(store.subagentMessagesFor('tool-a')[0]?.textBlocks?.[0]?.text).toBe('正在读取文件')
    })

    test('同 id 的子 Agent 消息合并而非裂成两条', () => {
      const store = useMessageStore()
      store.setCurrentSession('session-1')
      const base = {
        type: 'subagent_message' as const,
        turnId: 'turn-1',
        parentToolUseId: 'tool-a',
      }
      store.applyEvent('session-1', {
        ...base,
        message: {
          id: 'sub-1',
          role: 'assistant',
          turnId: 'turn-1',
          textBlocks: [{ id: 'b1', text: '先想一下', kind: 'reasoning' }],
          toolBlocks: [],
          createdAt: 0,
        },
      })
      store.applyEvent('session-1', {
        ...base,
        message: {
          id: 'sub-1',
          role: 'assistant',
          turnId: 'turn-1',
          textBlocks: [],
          toolBlocks: [
            { id: 'sub-tool-1', info: { kind: 'other', title: 'Read' }, status: 'running' },
          ],
          createdAt: 0,
        },
      })

      const list = store.subagentMessagesFor('tool-a')
      expect(list).toHaveLength(1)
      expect(list[0]?.textBlocks).toHaveLength(1)
      expect(list[0]?.toolBlocks).toHaveLength(1)
    })

    test('子 Agent 内部工具结果回填到对应工具块', () => {
      const store = useMessageStore()
      store.setCurrentSession('session-1')
      store.applyEvent('session-1', {
        type: 'subagent_message',
        turnId: 'turn-1',
        parentToolUseId: 'tool-a',
        message: {
          id: 'sub-1',
          role: 'assistant',
          turnId: 'turn-1',
          textBlocks: [],
          toolBlocks: [
            { id: 'sub-tool-1', info: { kind: 'other', title: 'Read' }, status: 'running' },
          ],
          createdAt: 0,
        },
      })
      store.applyEvent('session-1', {
        type: 'subagent_tool_result',
        turnId: 'turn-1',
        parentToolUseId: 'tool-a',
        toolUseId: 'sub-tool-1',
        output: { ok: true, summary: '读到 120 行' },
      })

      const block = store.subagentMessagesFor('tool-a')[0]?.toolBlocks?.[0]
      expect(block?.status).toBe('completed')
      expect(block?.output).toMatchObject({ ok: true, summary: '读到 120 行' })
    })

    test('任务表按 session 隔离', () => {
      const store = useMessageStore()
      store.setCurrentSession('session-1')
      store.applyEvent('session-1', {
        type: 'background_task_updated',
        turnId: 'turn-1',
        task: { taskId: 'task-a', status: 'running', stats: { status: 'running' } },
      })

      store.setCurrentSession('session-2')
      expect(store.backgroundTasks).toHaveLength(0)
      expect(store.runningBackgroundTaskCount).toBe(0)

      store.setCurrentSession('session-1')
      expect(store.backgroundTasks).toHaveLength(1)
    })
  })
})
