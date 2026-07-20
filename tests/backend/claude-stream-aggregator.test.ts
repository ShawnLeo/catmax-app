// @vitest-environment node
/**
 * Bug G 测试：StreamEventAggregator 把 claude --include-partial-messages 的
 * stream_event 流转换成逐 token 的 text_delta / reasoning_delta TurnEvent。
 *
 * Claude streaming 协议（Anthropic Messages API）：
 *   message_start
 *   content_block_start { index, content_block: {type: 'thinking'|'text'|'tool_use'} }
 *   content_block_delta { index, delta: {type: 'thinking_delta', thinking: '...'} }
 *   content_block_delta { index, delta: {type: 'text_delta', text: '...'} }
 *   content_block_stop  { index }
 *   message_stop
 *
 * 之前 bug：ClaudeAdapter 没加 --include-partial-messages，claude 等整块生成完才
 * 推一个完整 assistant 消息——UI 看起来是"全部响应完才一次性渲染"。
 */
import { describe, expect, test } from 'vitest'

import { StreamEventAggregator } from '@main/backend/claude/mapping'
import type { StreamEventMessage } from '@shared/backend/claude-schema'
import type { TurnEvent } from '@shared/backend/types'

function makeStreamEvent(event: unknown): StreamEventMessage {
  return { type: 'stream_event', event } as StreamEventMessage
}

/** 收集 aggregator push 一批 events 的返回值 */
function collectEvents(agg: StreamEventAggregator, msgs: StreamEventMessage[]): TurnEvent[] {
  const out: TurnEvent[] = []
  for (const m of msgs) {
    out.push(...agg.push(m))
  }
  return out
}

describe('StreamEventAggregator', () => {
  test('thinking_delta → reasoning_delta（逐 token 累积）', () => {
    const agg = new StreamEventAggregator('turn-1')
    const events = collectEvents(agg, [
      makeStreamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      }),
      makeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '用户' },
      }),
      makeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '问' },
      }),
      makeStreamEvent({ type: 'content_block_stop', index: 0 }),
    ])

    expect(events.length).toBe(2)
    expect(events[0]).toMatchObject({
      type: 'reasoning_delta',
      turnId: 'turn-1',
      text: '用户',
    })
    expect(events[1]).toMatchObject({ type: 'reasoning_delta', text: '问' })
    // 同一 block 的 itemId 应该一致
    expect((events[0] as { itemId: string }).itemId).toBe(
      (events[1] as { itemId: string }).itemId,
    )
  })

  test('text_delta → text_delta（逐 token 累积）', () => {
    const agg = new StreamEventAggregator('turn-1')
    const events = collectEvents(agg, [
      makeStreamEvent({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      }),
      makeStreamEvent({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'hello' },
      }),
      makeStreamEvent({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: ' world' },
      }),
    ])

    expect(events.length).toBe(2)
    expect(events[0]).toMatchObject({ type: 'text_delta', text: 'hello' })
    expect(events[1]).toMatchObject({ type: 'text_delta', text: ' world' })
  })

  test('不同 block 的 itemId 不同（thinking 块和 text 块各自独立）', () => {
    const agg = new StreamEventAggregator('turn-1')
    const events = collectEvents(agg, [
      makeStreamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      }),
      makeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '想一下' },
      }),
      makeStreamEvent({ type: 'content_block_stop', index: 0 }),
      makeStreamEvent({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      }),
      makeStreamEvent({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: '回答' },
      }),
    ])

    expect(events.length).toBe(2)
    expect(events[0]?.type).toBe('reasoning_delta')
    expect(events[1]?.type).toBe('text_delta')
    expect((events[0] as { itemId: string }).itemId).not.toBe(
      (events[1] as { itemId: string }).itemId,
    )
  })

  test('tool_use: input_json_delta 累积，content_block_stop 时发 tool_call_started', () => {
    const agg = new StreamEventAggregator('turn-1')
    const events = collectEvents(agg, [
      makeStreamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tool_1', name: 'Bash', input: {} },
      }),
      // input JSON 被切片成多个 partial_json
      makeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"command": "ls' },
      }),
      makeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: ' -la"}' },
      }),
      makeStreamEvent({ type: 'content_block_stop', index: 0 }),
    ])

    // input_json_delta 期间不发 UI 事件，stop 时一次性发 tool_call_started
    expect(events.length).toBe(1)
    expect(events[0]?.type).toBe('tool_call_started')
    const started = events[0] as Extract<TurnEvent, { type: 'tool_call_started' }>
    expect(started.itemId).toBe('tool_1') // 用 claude 给的 tool_use id
    expect(started.tool.kind).toBe('shell_command') // Bash → shell_command
    expect(started.tool.title).toBe('ls -la')
    expect(started.tool.detail).toBe('ls -la') // Bash 的 detail 是 command 字符串
  })

  test('flushPendingToolUse: 没收到 content_block_stop 时兜底发出 tool_call_started', () => {
    const agg = new StreamEventAggregator('turn-1')
    // 进程提前退出，content_block_stop 没到
    collectEvents(agg, [
      makeStreamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tool_x', name: 'Read', input: {} },
      }),
      makeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/a"}' },
      }),
    ])
    const flushed = agg.flushPendingToolUse()

    expect(flushed.length).toBe(1)
    expect(flushed[0]?.type).toBe('tool_call_started')
    expect((flushed[0] as Extract<TurnEvent, { type: 'tool_call_started' }>).tool.kind).toBe(
      'file_read',
    )
  })

  test('message_start / message_delta / message_stop 等不产生事件', () => {
    const agg = new StreamEventAggregator('turn-1')
    const events = collectEvents(agg, [
      makeStreamEvent({ type: 'message_start', message: {} }),
      makeStreamEvent({ type: 'ping' }),
      makeStreamEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      makeStreamEvent({ type: 'message_stop' }),
    ])
    expect(events).toEqual([])
  })

  test('空 text/thinking delta 被忽略（不发空事件）', () => {
    const agg = new StreamEventAggregator('turn-1')
    const events = collectEvents(agg, [
      makeStreamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      makeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '' }, // 空
      }),
      makeStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'a' },
      }),
    ])
    expect(events.length).toBe(1) // 只有 'a' 那条
    expect(events[0]).toMatchObject({ text: 'a' })
  })
})
