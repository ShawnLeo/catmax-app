// @vitest-environment node
/**
 * Steer Continuation: 运行中追加的消息，它跑出来的那一轮必须留在同一个 catmax turn 里。
 *
 * SDK 不把运行中收到的 user message 并进当前回合，而是排队、等当前回合的 result 之后
 * 再当成新的一轮跑（transcript 里的 `queue-operation: enqueue` / `dequeue`）。
 * adapter 若在第一个 result 就收 turn，那一轮的全部输出都落在终态之后——
 * adapter 自己 `continue` 掉，协调器也在 turn_completed 之后丢弃一切——
 * 用户看到的就是"补充的消息发出去了，页面上毫无反应"。
 */
import type { SDKMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { TurnEvent } from '@shared/backend/types'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const sdkMocks = vi.hoisted(() => {
  const state = {
    messages: [] as SDKMessage[],
    /** 迭代到这个下标前先卡住，让测试有机会在"第一轮还没结束"时 steer。 */
    holdBeforeIndex: null as number | null,
    releaseIterator: null as (() => void) | null,
    input: null as AsyncIterable<SDKUserMessage> | null,
  }
  const queryObject = {
    initializationResult: vi.fn(async () => ({ models: [] })),
    interrupt: vi.fn(async () => {}),
    stopTask: vi.fn(async () => {}),
    async *[Symbol.asyncIterator](): AsyncIterableIterator<SDKMessage> {
      for (const [index, message] of state.messages.entries()) {
        if (state.holdBeforeIndex === index) {
          await new Promise<void>((resolve) => {
            state.releaseIterator = resolve
          })
        }
        yield message
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

function result(uuid: string, isError = false): SDKResultMessage {
  return {
    type: 'result',
    subtype: isError ? 'error_during_execution' : 'success',
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: isError,
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

/** 事件流里出现过的所有正文，用来断言"追加那一轮的输出确实流出来了"。 */
function texts(events: TurnEvent[]): string[] {
  const out: string[] = []
  for (const event of events) {
    if (event.type === 'text_delta') out.push(event.text)
    else if (event.type === 'content_block_upsert' && event.block.type === 'text') {
      out.push(event.block.text)
    }
  }
  return out
}

/**
 * 跑一个 turn：卡在 holdBeforeIndex 时执行 duringHold（拿到 turnId），再放行。
 */
async function runTurnWithHold(
  adapter: InstanceType<typeof ClaudeAdapter>,
  duringHold: (turnId: string) => Promise<void>,
): Promise<TurnEvent[]> {
  const events: TurnEvent[] = []
  const consume = (async () => {
    for await (const event of adapter.startTurn({
      sessionId: 'catmax-session',
      prompt: '看一下我飞书 Client 的技能',
    })) {
      events.push(event)
    }
  })()

  await vi.waitFor(() => {
    expect(sdkMocks.state.releaseIterator).not.toBeNull()
    expect(events.length).toBeGreaterThan(0)
  })
  await duringHold(events[0]!.turnId)
  sdkMocks.state.releaseIterator!()
  await consume
  return events
}

describe('ClaudeAdapter steer continuation', () => {
  beforeEach(() => {
    sdkMocks.state.messages = []
    sdkMocks.state.holdBeforeIndex = null
    sdkMocks.state.releaseIterator = null
    sdkMocks.state.input = null
    sdkMocks.query.mockClear()
    sdkMocks.queryObject.initializationResult.mockClear()
  })

  test('运行中 steer：追加那一轮的输出留在同一个 turn 里，终态只有一个', async () => {
    sdkMocks.state.messages = [
      assistantText('assistant-1', '技能列表如下'),
      result('result-1'),
      // 以下是 SDK dequeue 掉排队消息后跑出来的第二轮
      assistantText('assistant-2', '二维码已生成，请扫码'),
      result('result-2'),
    ]
    sdkMocks.state.holdBeforeIndex = 1
    const adapter = new ClaudeAdapter()

    const events = await runTurnWithHold(adapter, async (turnId) => {
      await adapter.steer(turnId, '帮我登录一下我的飞书。')
    })

    expect(events.filter((event) => event.type === 'turn_completed')).toHaveLength(1)
    expect(events.at(-1)?.type).toBe('turn_completed')
    // 关键断言：追加那一轮的正文必须出现，且排在第一轮之后
    expect(texts(events)).toEqual(['技能列表如下', '二维码已生成，请扫码'])
    expect(events.some((event) => event.type === 'error')).toBe(false)
  })

  test('steer 后 SDK 没再跑一轮就收流：用扣下的终态收尾，不报假错误', async () => {
    sdkMocks.state.messages = [assistantText('assistant-1', '技能列表如下'), result('result-1')]
    sdkMocks.state.holdBeforeIndex = 1
    const adapter = new ClaudeAdapter()

    const events = await runTurnWithHold(adapter, async (turnId) => {
      await adapter.steer(turnId, '帮我登录一下我的飞书。')
    })

    const terminal = events.filter((event) => event.type === 'turn_completed')
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toMatchObject({ status: 'completed' })
    expect(events.some((event) => event.type === 'error')).toBe(false)
  })

  test('result 报错时不为 steer 扣住终态——那一轮已经失败，如常收尾', async () => {
    sdkMocks.state.messages = [
      assistantText('assistant-1', '技能列表如下'),
      result('result-1', true),
      assistantText('assistant-2', '不该被算进这个 turn'),
      result('result-2'),
    ]
    sdkMocks.state.holdBeforeIndex = 1
    const adapter = new ClaudeAdapter()

    const events = await runTurnWithHold(adapter, async (turnId) => {
      await adapter.steer(turnId, '帮我登录一下我的飞书。')
    })

    expect(events.filter((event) => event.type === 'turn_completed')).toHaveLength(1)
    expect(events.find((event) => event.type === 'turn_completed')).toMatchObject({
      status: 'error',
    })
    expect(texts(events)).toEqual(['技能列表如下'])
  })

  test('没有 steer 时行为不变：第一个 result 就是终态', async () => {
    sdkMocks.state.messages = [
      assistantText('assistant-1', '技能列表如下'),
      result('result-1'),
      assistantText('assistant-2', '不该被算进这个 turn'),
      result('result-2'),
    ]
    sdkMocks.state.holdBeforeIndex = 1
    const adapter = new ClaudeAdapter()

    const events = await runTurnWithHold(adapter, async () => {})

    expect(events.filter((event) => event.type === 'turn_completed')).toHaveLength(1)
    expect(texts(events)).toEqual(['技能列表如下'])
  })
})
