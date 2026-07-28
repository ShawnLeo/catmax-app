// @vitest-environment node
import type { SDKMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { TurnEvent } from '@shared/backend/types'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const sdkMocks = vi.hoisted(() => {
  const state = {
    messages: [] as SDKMessage[],
    abortSignal: null as AbortSignal | null,
    waitForInterrupt: false,
    releaseIterator: null as (() => void) | null,
    input: null as AsyncIterable<SDKUserMessage> | null,
  }
  const queryObject = {
    initializationResult: vi.fn(async () => ({ models: [] })),
    interrupt: vi.fn(async () => {
      state.releaseIterator?.()
    }),
    stopTask: vi.fn(async () => {}),
    async *[Symbol.asyncIterator](): AsyncIterableIterator<SDKMessage> {
      for (const message of state.messages) yield message
      if (state.waitForInterrupt) {
        await new Promise<void>((resolve) => {
          state.releaseIterator = resolve
        })
      }
    },
  }
  return {
    state,
    queryObject,
    query: vi.fn(
      (params: {
        prompt: AsyncIterable<SDKUserMessage>
        options: { abortController: AbortController }
      }) => {
        state.abortSignal = params.options.abortController.signal
        state.input = params.prompt
        return queryObject
      },
    ),
    deleteSession: vi.fn(async () => {}),
  }
})

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  deleteSession: sdkMocks.deleteSession,
  query: sdkMocks.query,
}))
vi.mock('electron', () => ({
  app: { isPackaged: false },
}))

const { ClaudeAdapter } = await import('@main/backend/claude/adapter')

function result(uuid: string, origin?: 'human' | 'task-notification'): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result: 'ok',
    stop_reason: 'end_turn',
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 2,
      output_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: {},
      service_tier: 'standard',
    },
    modelUsage: {},
    permission_denials: [],
    ...(origin ? { origin: { kind: origin } } : {}),
    uuid,
    session_id: 'claude-session',
  } as unknown as SDKResultMessage
}

function assistantText(uuid: string, text: string): SDKMessage {
  return {
    type: 'assistant',
    message: {
      id: uuid,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet',
      content: [{ type: 'text', text, citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: null,
        service_tier: null,
      },
    },
    parent_tool_use_id: null,
    uuid,
    session_id: 'claude-session',
  } as unknown as SDKMessage
}

async function collectEvents(iterable: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const events: TurnEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

describe('ClaudeAdapter background turn lifecycle', () => {
  beforeEach(() => {
    sdkMocks.state.messages = []
    sdkMocks.state.abortSignal = null
    sdkMocks.state.waitForInterrupt = false
    sdkMocks.state.releaseIterator = null
    sdkMocks.state.input = null
    sdkMocks.query.mockClear()
    sdkMocks.queryObject.initializationResult.mockClear()
    sdkMocks.queryObject.interrupt.mockClear()
    sdkMocks.queryObject.stopTask.mockClear()
  })

  test('正常 result 完成后不会在 generator finally 中误触发 abort', async () => {
    sdkMocks.state.messages = [
      {
        type: 'system',
        subtype: 'init',
        uuid: 'init-1',
        session_id: 'claude-session',
      } as unknown as SDKMessage,
      assistantText('assistant-1', '完成'),
      result('result-1'),
    ]
    const adapter = new ClaudeAdapter()

    const events = await collectEvents(
      adapter.startTurn({ sessionId: 'catmax-session', prompt: '你好' }),
    )

    expect(events.filter((event) => event.type === 'turn_completed')).toHaveLength(1)
    expect(sdkMocks.state.abortSignal?.aborted).toBe(false)
    expect(sdkMocks.queryObject.interrupt).not.toHaveBeenCalled()
  })

  test('首个 result 后继续等待两个并行 Agent，并只在最终汇总后结束', async () => {
    sdkMocks.state.messages = [
      {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [
          { task_id: 'agent-a', task_type: 'local_agent', description: '分析代理' },
          { task_id: 'agent-b', task_type: 'local_agent', description: '分析协议' },
        ],
        uuid: 'membership-1',
        session_id: 'claude-session',
      },
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'agent-a',
        tool_use_id: 'tool-a',
        description: '分析代理',
        uuid: 'started-a',
        session_id: 'claude-session',
      },
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'agent-b',
        tool_use_id: 'tool-b',
        description: '分析协议',
        uuid: 'started-b',
        session_id: 'claude-session',
      },
      assistantText('assistant-waiting', '两个 Agent 正在后台分析，我先等结果。'),
      result('initial-result', 'human'),
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-a',
        tool_use_id: 'tool-a',
        status: 'completed',
        output_file: '/tmp/agent-a',
        summary: '代理分析完成',
        uuid: 'notification-a',
        session_id: 'claude-session',
      },
      result('partial-followup', 'task-notification'),
      {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [],
        uuid: 'membership-empty',
        session_id: 'claude-session',
      },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-b',
        tool_use_id: 'tool-b',
        status: 'completed',
        output_file: '/tmp/agent-b',
        summary: '协议分析完成',
        uuid: 'notification-b',
        session_id: 'claude-session',
      },
      assistantText('assistant-final', '两个分析均已完成，这是完整结论。'),
      result('final-result', 'task-notification'),
    ] as SDKMessage[]
    const adapter = new ClaudeAdapter()

    const events = await collectEvents(
      adapter.startTurn({ sessionId: 'catmax-session', prompt: '并行分析' }),
    )

    const text = events
      .filter((event): event is Extract<TurnEvent, { type: 'text_delta' }> => {
        return event.type === 'text_delta'
      })
      .map((event) => event.text)
    const taskUpdates = events.filter(
      (event): event is Extract<TurnEvent, { type: 'background_task_updated' }> => {
        return event.type === 'background_task_updated'
      },
    )

    expect(text).toEqual([
      '两个 Agent 正在后台分析，我先等结果。',
      '两个分析均已完成，这是完整结论。',
    ])
    expect(taskUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ task: expect.objectContaining({ taskId: 'agent-a' }) }),
        expect.objectContaining({
          task: expect.objectContaining({ taskId: 'agent-b', status: 'completed' }),
        }),
      ]),
    )
    expect(events.filter((event) => event.type === 'turn_completed')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed', status: 'completed' })
    expect(sdkMocks.state.abortSignal?.aborted).toBe(false)
  })

  test('用户停止时先 stopTask 所有后台 Agent，再以 interrupted 结束父 turn', async () => {
    sdkMocks.state.waitForInterrupt = true
    sdkMocks.state.messages = [
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'agent-a',
        tool_use_id: 'tool-a',
        description: '分析代理',
        uuid: 'started-a',
        session_id: 'claude-session',
      },
    ] as unknown as SDKMessage[]
    const adapter = new ClaudeAdapter()
    const events: TurnEvent[] = []
    const collectPromise = (async () => {
      for await (const event of adapter.startTurn({
        sessionId: 'catmax-session',
        prompt: '并行分析',
      })) {
        events.push(event)
      }
    })()

    while (!events.some((event) => event.type === 'background_task_updated')) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const turnId = events.find((event) => event.type === 'turn_started')?.turnId
    expect(turnId).toBeDefined()
    if (!turnId) throw new Error('turn_started event missing')
    await adapter.interrupt(turnId)
    await collectPromise

    expect(sdkMocks.queryObject.stopTask).toHaveBeenCalledWith('agent-a')
    expect(sdkMocks.queryObject.interrupt).toHaveBeenCalledOnce()
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'background_task_updated',
          task: expect.objectContaining({ taskId: 'agent-a', status: 'stopped' }),
        }),
        expect.objectContaining({ type: 'turn_completed', status: 'interrupted' }),
      ]),
    )
  })

  test('steer 把追加指令写入同一个 streaming input', async () => {
    sdkMocks.state.waitForInterrupt = true
    sdkMocks.state.messages = [
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'agent-a',
        tool_use_id: 'tool-a',
        description: '分析代理',
        uuid: 'started-a',
        session_id: 'claude-session',
      },
    ] as unknown as SDKMessage[]
    const adapter = new ClaudeAdapter()
    const events: TurnEvent[] = []
    const collectPromise = (async () => {
      for await (const event of adapter.startTurn({
        sessionId: 'catmax-session',
        prompt: '初始指令',
      })) {
        events.push(event)
      }
    })()

    while (!events.some((event) => event.type === 'background_task_updated')) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const turnId = events.find((event) => event.type === 'turn_started')?.turnId
    const input = sdkMocks.state.input
    if (!turnId || !input) throw new Error('turn/input missing')
    const iterator = input[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({
      message: { content: '初始指令' },
      origin: { kind: 'human' },
    })

    await adapter.steer(turnId, '补充检查协议转换')
    expect((await iterator.next()).value).toMatchObject({
      message: { content: '补充检查协议转换' },
      origin: { kind: 'human' },
    })

    await adapter.interrupt(turnId)
    await collectPromise
  })
})
