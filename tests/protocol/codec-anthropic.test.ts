// @vitest-environment node

import {
  anthropicMessagesCodec,
  effortToThinkingBudget,
} from '@main/protocol/codecs/anthropic-messages'
import { DEFAULT_UPSTREAM_CAPABILITIES, type UpstreamCapabilities } from '@shared/protocol/codec'
import type { IrRequest, IrStreamEvent } from '@shared/protocol/ir'
import { describe, expect, test } from 'vitest'

const CAPS: UpstreamCapabilities = { ...DEFAULT_UPSTREAM_CAPABILITIES }
/** DeepSeek 的实际能力：不收图片、忽略 thinking budget */
const DEEPSEEK_CAPS: UpstreamCapabilities = {
  ...DEFAULT_UPSTREAM_CAPABILITIES,
  supportsImages: false,
  respectsThinkingBudget: false,
}

function baseRequest(overrides: Partial<IrRequest> = {}): IrRequest {
  return {
    model: 'deepseek-v4-pro',
    system: '',
    messages: [{ role: 'user', blocks: [{ kind: 'text', text: 'hi' }] }],
    tools: [],
    toolChoice: { mode: 'auto' },
    maxOutputTokens: null,
    temperature: null,
    topP: null,
    reasoning: { enabled: false, effort: null },
    stream: true,
    vendor: { protocol: 'openai.responses', body: {} },
    ...overrides,
  }
}

function encode(ir: IrRequest, caps = CAPS): Record<string, unknown> {
  return anthropicMessagesCodec.encodeRequest(ir, caps) as Record<string, unknown>
}

describe('encodeRequest', () => {
  test('max_tokens 必填——请求没给时用 capabilities 的兜底值', () => {
    expect(encode(baseRequest()).max_tokens).toBe(
      DEFAULT_UPSTREAM_CAPABILITIES.defaultMaxOutputTokens,
    )
    expect(encode(baseRequest({ maxOutputTokens: 4096 })).max_tokens).toBe(4096)
  })

  test('system 走顶层字段而不是塞进 messages', () => {
    const body = encode(baseRequest({ system: 'You are Codex.' }))
    expect(body.system).toBe('You are Codex.')
    expect(JSON.stringify(body.messages)).not.toContain('You are Codex.')
  })

  test('开思考时必须去掉 temperature / top_p，否则上游 400', () => {
    const body = encode(
      baseRequest({
        temperature: 0.7,
        topP: 0.9,
        reasoning: { enabled: true, effort: 'medium' },
      }),
    )
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 })
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
  })

  test('不开思考时采样参数正常透传', () => {
    const body = encode(baseRequest({ temperature: 0.7, topP: 0.9 }))
    expect(body.temperature).toBe(0.7)
    expect(body.top_p).toBe(0.9)
    expect(body.thinking).toBeUndefined()
  })

  test('effort=none 视为关闭思考', () => {
    const body = encode(baseRequest({ reasoning: { enabled: true, effort: 'none' } }))
    expect(body.thinking).toBeUndefined()
  })

  test('max_tokens 必须大于 thinking budget', () => {
    const body = encode(
      baseRequest({ maxOutputTokens: 1000, reasoning: { enabled: true, effort: 'high' } }),
    )
    expect(body.max_tokens as number).toBeGreaterThan(16384)
  })

  test('tool_result 块被提到 user 消息最前面', () => {
    const body = encode(
      baseRequest({
        messages: [
          {
            role: 'user',
            blocks: [
              { kind: 'text', text: '继续' },
              {
                kind: 'tool_result',
                callId: 'call_1',
                content: [{ kind: 'text', text: 'ok' }],
                isError: false,
              },
            ],
          },
        ],
      }),
    )
    const content = (body.messages as Array<{ content: Array<{ type: string }> }>)[0]!.content
    expect(content[0]!.type).toBe('tool_result')
    expect(content[1]!.type).toBe('text')
  })

  test('thinking 块被提到 assistant 消息最前面', () => {
    const body = encode(
      baseRequest({
        reasoning: { enabled: true, effort: 'medium' },
        messages: [
          {
            role: 'assistant',
            blocks: [
              { kind: 'text', text: '答案' },
              {
                kind: 'reasoning',
                text: '想了想',
                opaque: { protocol: 'anthropic.messages', payload: { signature: 'sig-1' } },
              },
            ],
          },
        ],
      }),
    )
    const content = (body.messages as Array<{ content: Array<{ type: string }> }>)[0]!.content
    expect(content[0]!.type).toBe('thinking')
    expect(content[1]!.type).toBe('text')
  })

  test('thinking 签名原样回传', () => {
    const body = encode(
      baseRequest({
        reasoning: { enabled: true, effort: 'medium' },
        messages: [
          {
            role: 'assistant',
            blocks: [
              {
                kind: 'reasoning',
                text: '思考内容',
                opaque: { protocol: 'anthropic.messages', payload: { signature: 'sig-abc' } },
              },
            ],
          },
        ],
      }),
    )
    const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!
      .content
    expect(content[0]).toEqual({ type: 'thinking', thinking: '思考内容', signature: 'sig-abc' })
  })

  test('没有签名的 thinking 块降级成普通文本，不赌上游宽松', () => {
    const body = encode(
      baseRequest({
        reasoning: { enabled: true, effort: 'medium' },
        messages: [
          { role: 'assistant', blocks: [{ kind: 'reasoning', text: '裸思考', opaque: null }] },
        ],
      }),
    )
    const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!
      .content
    expect(content[0]).toEqual({ type: 'text', text: '裸思考' })
  })

  test('没开思考时 reasoning 块整个丢掉——回传会被上游拒', () => {
    const body = encode(
      baseRequest({
        messages: [
          {
            role: 'assistant',
            blocks: [
              {
                kind: 'reasoning',
                text: 'x',
                opaque: { protocol: 'anthropic.messages', payload: { signature: 's' } },
              },
              { kind: 'text', text: '答案' },
            ],
          },
        ],
      }),
    )
    const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!
      .content
    expect(content).toEqual([{ type: 'text', text: '答案' }])
  })

  test('上游不支持图片时降级成占位文字而不是原样发过去', () => {
    const body = encode(
      baseRequest({
        messages: [
          { role: 'user', blocks: [{ kind: 'image', mediaType: 'image/png', dataBase64: 'AAAA' }] },
        ],
      }),
      DEEPSEEK_CAPS,
    )
    const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!
      .content
    expect(content[0]!.type).toBe('text')
    expect(String(content[0]!.text)).toContain('不支持图片')
  })

  test('上游支持图片时原样编码成 base64 source', () => {
    const body = encode(
      baseRequest({
        messages: [
          { role: 'user', blocks: [{ kind: 'image', mediaType: 'image/png', dataBase64: 'AAAA' }] },
        ],
      }),
    )
    const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!
      .content
    expect(content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    })
  })

  test('工具的 input_schema 顶层强制是 object', () => {
    const body = encode(
      baseRequest({
        tools: [
          {
            name: 'shell',
            description: '跑命令',
            parameters: { properties: { cmd: { type: 'string' } } },
          },
          { name: 'noargs', description: '', parameters: {} },
        ],
      }),
    )
    const tools = body.tools as Array<{ name: string; input_schema: Record<string, unknown> }>
    expect(tools[0]!.input_schema.type).toBe('object')
    expect(tools[0]!.input_schema.properties).toEqual({ cmd: { type: 'string' } })
    expect(tools[1]!.input_schema).toEqual({ type: 'object', properties: {} })
  })

  test('tool_choice 各档位映射到 Anthropic 的说法', () => {
    const withTool = (mode: IrRequest['toolChoice']): unknown =>
      encode(
        baseRequest({ tools: [{ name: 't', description: '', parameters: {} }], toolChoice: mode }),
      ).tool_choice
    expect(withTool({ mode: 'auto' })).toEqual({ type: 'auto' })
    expect(withTool({ mode: 'required' })).toEqual({ type: 'any' })
    expect(withTool({ mode: 'none' })).toEqual({ type: 'none' })
    expect(withTool({ mode: 'tool', name: 'shell' })).toEqual({ type: 'tool', name: 'shell' })
  })

  test('没有工具时不发 tools / tool_choice——空 tools 带 tool_choice 会被严格网关拒', () => {
    const body = encode(baseRequest())
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
  })

  test('工具参数是非法 JSON 时退化成空对象而不是让整轮挂掉', () => {
    const body = encode(
      baseRequest({
        messages: [
          {
            role: 'assistant',
            blocks: [
              {
                kind: 'tool_call',
                callId: 'c1',
                name: 'shell',
                argumentsJson: '{bad',
                opaque: null,
              },
            ],
          },
        ],
      }),
    )
    const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!
      .content
    expect(content[0]).toEqual({ type: 'tool_use', id: 'c1', name: 'shell', input: {} })
  })

  test('超长工具名确定性截断——同名两次得到同一结果', () => {
    const long = 'a'.repeat(100)
    const first = encode(baseRequest({ tools: [{ name: long, description: '', parameters: {} }] }))
    const second = encode(baseRequest({ tools: [{ name: long, description: '', parameters: {} }] }))
    const nameOf = (b: Record<string, unknown>): string =>
      (b.tools as Array<{ name: string }>)[0]!.name
    expect(nameOf(first)).toHaveLength(64)
    expect(nameOf(first)).toBe(nameOf(second))
  })

  test('effort → budget 梯度', () => {
    expect(effortToThinkingBudget('none')).toBeNull()
    expect(effortToThinkingBudget('low')).toBe(2048)
    expect(effortToThinkingBudget('medium')).toBe(8192)
    expect(effortToThinkingBudget('high')).toBe(16384)
    expect(effortToThinkingBudget('max')).toBe(32768)
    expect(effortToThinkingBudget(null)).toBe(8192)
  })
})

// ---------------------------------------------------------------------------

function decodeStream(chunks: string[]): IrStreamEvent[] {
  const decoder = anthropicMessagesCodec.createStreamDecoder()
  const events: IrStreamEvent[] = []
  for (const chunk of chunks) events.push(...decoder.push(Buffer.from(chunk, 'utf-8')))
  events.push(...decoder.finish())
  return events
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

describe('createStreamDecoder', () => {
  test('完整一轮：thinking + text + tool_use', () => {
    const events = decodeStream([
      sse('message_start', {
        type: 'message_start',
        message: { id: 'msg_1', model: 'deepseek-v4-pro', usage: { input_tokens: 12 } },
      }),
      sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '想' } }),
      sse('content_block_delta', {
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig' },
      }),
      sse('content_block_stop', { index: 0 }),
      sse('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
      sse('content_block_delta', { index: 1, delta: { type: 'text_delta', text: '好' } }),
      sse('content_block_stop', { index: 1 }),
      sse('content_block_start', {
        index: 2,
        content_block: { type: 'tool_use', id: 'call_1', name: 'shell' },
      }),
      sse('content_block_delta', {
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"a"' },
      }),
      sse('content_block_delta', {
        index: 2,
        delta: { type: 'input_json_delta', partial_json: ':1}' },
      }),
      sse('content_block_stop', { index: 2 }),
      sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } }),
      sse('message_stop', { type: 'message_stop' }),
    ])

    expect(events[0]).toEqual({ type: 'start', responseId: 'msg_1', model: 'deepseek-v4-pro' })
    expect(events).toContainEqual({ type: 'block_start', index: 0, block: { kind: 'reasoning' } })
    expect(events).toContainEqual({ type: 'block_delta', index: 0, delta: '想' })
    // 签名不是可见内容，走 block_meta
    expect(events).toContainEqual({
      type: 'block_meta',
      index: 0,
      opaque: { protocol: 'anthropic.messages', payload: { signature: 'sig' } },
    })
    expect(events).toContainEqual({
      type: 'block_start',
      index: 2,
      block: { kind: 'tool_call', callId: 'call_1', name: 'shell' },
    })
    // 工具参数按分片拼
    expect(
      events
        .filter((e) => e.type === 'block_delta' && e.index === 2)
        .map((e) => (e as { delta: string }).delta),
    ).toEqual(['{"a"', ':1}'])

    const usage = events.find((e) => e.type === 'usage')
    expect(usage).toEqual({
      type: 'usage',
      usage: { inputTokens: 12, outputTokens: 42, cachedInputTokens: 0, reasoningTokens: 0 },
    })
    expect(events[events.length - 1]).toEqual({ type: 'end', stopReason: 'tool_use' })
  })

  test('message_delta 的 usage 只带 output，input 沿用 message_start 的', () => {
    const events = decodeStream([
      sse('message_start', {
        message: { id: 'm', model: 'x', usage: { input_tokens: 100, cache_read_input_tokens: 30 } },
      }),
      sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }),
      sse('message_stop', {}),
    ])
    expect(events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      usage: { inputTokens: 100, outputTokens: 7, cachedInputTokens: 30, reasoningTokens: 0 },
    })
  })

  test('content_block_start 里直接带完整 input 时也能拿到参数（有的网关不发 delta）', () => {
    const events = decodeStream([
      sse('content_block_start', {
        index: 0,
        content_block: { type: 'tool_use', id: 'c', name: 'n', input: { a: 1 } },
      }),
    ])
    expect(events).toContainEqual({ type: 'block_delta', index: 0, delta: '{"a":1}' })
  })

  test('error 事件转成 IR error', () => {
    const events = decodeStream([
      sse('error', { type: 'error', error: { type: 'overloaded_error', message: '太忙' } }),
    ])
    expect(events).toContainEqual({ type: 'error', message: '太忙', kind: 'overloaded_error' })
  })

  test('ping 心跳被忽略', () => {
    // 只看 push 的产出：finish() 会额外补一个 usage 事件（见下一个用例）
    const decoder = anthropicMessagesCodec.createStreamDecoder()
    expect(decoder.push(Buffer.from(sse('ping', { type: 'ping' }), 'utf-8'))).toEqual([])
  })

  test('流没给终态就断掉时只补 usage，不擅自合成 end', () => {
    const events = decodeStream([
      sse('message_start', { message: { id: 'm', model: 'x', usage: { input_tokens: 5 } } }),
      sse('content_block_start', { index: 0, content_block: { type: 'text' } }),
    ])
    expect(events.some((e) => e.type === 'end')).toBe(false)
    expect(events[events.length - 1]!.type).toBe('usage')
  })

  test('stop_reason 映射', () => {
    const reasonOf = (reason: string): unknown =>
      decodeStream([
        sse('message_delta', { delta: { stop_reason: reason } }),
        sse('message_stop', {}),
      ]).at(-1)
    expect(reasonOf('max_tokens')).toEqual({ type: 'end', stopReason: 'max_tokens' })
    expect(reasonOf('end_turn')).toEqual({ type: 'end', stopReason: 'completed' })
    expect(reasonOf('tool_use')).toEqual({ type: 'end', stopReason: 'tool_use' })
  })
})

describe('decodeResponse（非流式）', () => {
  test('整个响应体归一成同一组事件', () => {
    const events = anthropicMessagesCodec.decodeResponse({
      id: 'msg_1',
      model: 'deepseek-v4-pro',
      content: [
        { type: 'thinking', thinking: '想', signature: 'sig' },
        { type: 'text', text: '答' },
        { type: 'tool_use', id: 'c1', name: 'shell', input: { cmd: 'ls' } },
      ],
      usage: { input_tokens: 3, output_tokens: 4 },
      stop_reason: 'tool_use',
    })
    expect(events[0]).toEqual({ type: 'start', responseId: 'msg_1', model: 'deepseek-v4-pro' })
    expect(events).toContainEqual({ type: 'block_delta', index: 1, delta: '答' })
    expect(events).toContainEqual({ type: 'block_delta', index: 2, delta: '{"cmd":"ls"}' })
    expect(events.at(-1)).toEqual({ type: 'end', stopReason: 'tool_use' })
  })

  test('上游返回 error 对象时归一成 error 事件', () => {
    const events = anthropicMessagesCodec.decodeResponse({
      error: { type: 'invalid_request_error', message: 'model 不存在' },
    })
    expect(events).toEqual([
      { type: 'error', message: 'model 不存在', kind: 'invalid_request_error' },
    ])
  })
})

describe('authHeaders / upstreamPath', () => {
  test('用 x-api-key 而不是 Bearer，并带 anthropic-version', () => {
    expect(anthropicMessagesCodec.authHeaders('sk-test')).toEqual({
      'x-api-key': 'sk-test',
      'anthropic-version': '2023-06-01',
    })
    expect(anthropicMessagesCodec.upstreamPath()).toBe('/v1/messages')
  })
})
