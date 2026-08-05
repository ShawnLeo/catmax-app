// @vitest-environment node

import {
  decodeOpaque,
  encodeOpaque,
  openaiResponsesCodec,
} from '@main/protocol/codecs/openai-responses'
import {
  BridgeRequestError,
  DEFAULT_UPSTREAM_CAPABILITIES,
  type UpstreamCapabilities,
} from '@shared/protocol/codec'
import type { IrStreamEvent } from '@shared/protocol/ir'
import { describe, expect, test } from 'vitest'

const decode = openaiResponsesCodec.decodeRequest

describe('decodeRequest', () => {
  test('缺 model 直接报 400 而不是往下带一个空模型名', () => {
    expect(() => decode({ input: [] })).toThrow(BridgeRequestError)
    expect(() => decode('not an object')).toThrow(BridgeRequestError)
  })

  test('instructions 变成顶层 system，不混进 messages', () => {
    const ir = decode({ model: 'm', instructions: 'You are Codex.', input: 'hi' })
    expect(ir.system).toBe('You are Codex.')
    expect(ir.messages).toEqual([{ role: 'user', blocks: [{ kind: 'text', text: 'hi' }] }])
  })

  test('instructions 是数组形态时按顺序拼', () => {
    const ir = decode({ model: 'm', instructions: [{ text: 'a' }, { text: 'b' }], input: [] })
    expect(ir.system).toBe('a\n\nb')
  })

  test('function_call / function_call_output 映射成工具块，call_id 保持不变', () => {
    const ir = decode({
      model: 'm',
      input: [
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'shell',
          arguments: '{"cmd":"ls"}',
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'file.txt' },
      ],
    })
    expect(ir.messages).toEqual([
      {
        role: 'assistant',
        blocks: [
          {
            kind: 'tool_call',
            callId: 'call_1',
            name: 'shell',
            argumentsJson: '{"cmd":"ls"}',
            opaque: null,
          },
        ],
      },
      {
        role: 'user',
        blocks: [
          {
            kind: 'tool_result',
            callId: 'call_1',
            content: [{ kind: 'text', text: 'file.txt' }],
            isError: false,
          },
        ],
      },
    ])
  })

  test('工具结果的 {output, success:false} 形态被识别为错误', () => {
    const ir = decode({
      model: 'm',
      input: [
        { type: 'function_call_output', call_id: 'c', output: { output: '炸了', success: false } },
      ],
    })
    const block = ir.messages[0]!.blocks[0]!
    expect(block).toEqual({
      kind: 'tool_result',
      callId: 'c',
      content: [{ kind: 'text', text: '炸了' }],
      isError: true,
    })
  })

  test('连续同角色的 item 被合并——Anthropic 要求严格交替', () => {
    const ir = decode({
      model: 'm',
      input: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '先说一句' }],
        },
        { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' },
      ],
    })
    expect(ir.messages).toHaveLength(1)
    expect(ir.messages[0]!.role).toBe('assistant')
    expect(ir.messages[0]!.blocks.map((b) => b.kind)).toEqual(['text', 'tool_call'])
  })

  test('data URI 图片解成 image 块，http 链接降级成文字', () => {
    const ir = decode({
      model: 'm',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
            { type: 'input_image', image_url: 'https://example.com/a.png' },
          ],
        },
      ],
    })
    expect(ir.messages[0]!.blocks[0]).toEqual({
      kind: 'image',
      mediaType: 'image/png',
      dataBase64: 'AAAA',
    })
    expect(ir.messages[0]!.blocks[1]!.kind).toBe('text')
  })

  test('reasoning item 的 encrypted_content 若是我们的封装，解回上游原生载荷', () => {
    const opaque = { protocol: 'anthropic.messages' as const, payload: { signature: 'sig-1' } }
    const ir = decode({
      model: 'm',
      input: [
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: '想了想' }],
          encrypted_content: encodeOpaque(opaque),
        },
      ],
    })
    expect(ir.messages[0]!.blocks[0]).toEqual({
      kind: 'reasoning',
      text: '想了想',
      opaque,
    })
  })

  test('encrypted_content 不是我们的封装时，整个 item 原样留着走 Responses 通路', () => {
    const ir = decode({
      model: 'm',
      input: [
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'x' }],
          encrypted_content: 'gAAAA-真加密',
        },
      ],
    })
    const block = ir.messages[0]!.blocks[0]!
    expect(block.kind).toBe('reasoning')
    expect(block.kind === 'reasoning' && block.opaque?.protocol).toBe('openai.responses')
  })

  test('工具定义摊平成 IR 形态', () => {
    const ir = decode({
      model: 'm',
      input: [],
      tools: [
        { type: 'function', name: 'shell', description: '跑命令', parameters: { type: 'object' } },
        // custom / namespace 形态在 Anthropic 上游没有对应物，显式跳过
        { type: 'custom', name: 'apply_patch' },
      ],
    })
    expect(ir.tools).toEqual([
      { name: 'shell', description: '跑命令', parameters: { type: 'object' } },
    ])
  })

  test('reasoning.effort 各形态', () => {
    expect(decode({ model: 'm', input: [] }).reasoning).toEqual({ enabled: false, effort: null })
    expect(decode({ model: 'm', input: [], reasoning: { effort: 'high' } }).reasoning).toEqual({
      enabled: true,
      effort: 'high',
    })
    expect(decode({ model: 'm', input: [], reasoning: { effort: 'none' } }).reasoning).toEqual({
      enabled: false,
      effort: 'none',
    })
    expect(decode({ model: 'm', input: [], reasoning: null }).reasoning.enabled).toBe(false)
  })

  test('vendor 逐字保留原始请求体', () => {
    const body = { model: 'm', input: [], store: false, include: ['reasoning.encrypted_content'] }
    expect(decode(body).vendor).toEqual({ protocol: 'openai.responses', body })
  })

  test('stream 缺省视为 true——codex 一直是流式', () => {
    expect(decode({ model: 'm', input: [] }).stream).toBe(true)
    expect(decode({ model: 'm', input: [], stream: false }).stream).toBe(false)
  })
})

describe('opaque 封装', () => {
  test('封装 → 解封往返一致', () => {
    const opaque = { protocol: 'anthropic.messages' as const, payload: { signature: 'abc' } }
    expect(decodeOpaque(encodeOpaque(opaque))).toEqual(opaque)
  })

  test('不是我们的前缀时返回 null，不误解上游的真加密内容', () => {
    expect(decodeOpaque('gAAAAABn-real-encrypted')).toBeNull()
    expect(decodeOpaque(undefined)).toBeNull()
    expect(decodeOpaque('catmax-bridge-v1:!!!非法base64!!!')).toBeNull()
  })
})

// ---------------------------------------------------------------------------

function encodeAll(
  events: IrStreamEvent[],
  finish?: 'completed' | 'truncated' | 'error',
  caps: Partial<UpstreamCapabilities> = {},
): string {
  const encoder = openaiResponsesCodec.createResponseEncoder({
    capabilities: { ...DEFAULT_UPSTREAM_CAPABILITIES, ...caps },
    model: 'deepseek-v4-pro',
  })
  const out: Buffer[] = []
  for (const event of events) out.push(...encoder.push(event))
  if (finish) out.push(...encoder.finish(finish))
  return Buffer.concat(out).toString('utf-8')
}

function eventNames(sse: string): string[] {
  return [...sse.matchAll(/^event: (.+)$/gm)].map((m) => m[1]!)
}

describe('createResponseEncoder', () => {
  test('文本块产出完整的 Responses 事件序列', () => {
    const sse = encodeAll([
      { type: 'start', responseId: 'm', model: 'deepseek-v4-pro' },
      { type: 'block_start', index: 0, block: { kind: 'text' } },
      { type: 'block_delta', index: 0, delta: '你好' },
      { type: 'block_end', index: 0 },
      { type: 'end', stopReason: 'completed' },
    ])
    expect(eventNames(sse)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ])
  })

  test('reasoning 块用 summary 系列事件', () => {
    const sse = encodeAll([
      { type: 'block_start', index: 0, block: { kind: 'reasoning' } },
      { type: 'block_delta', index: 0, delta: '想' },
      { type: 'block_end', index: 0 },
      { type: 'end', stopReason: 'completed' },
    ])
    expect(eventNames(sse)).toContain('response.reasoning_summary_part.added')
    expect(eventNames(sse)).toContain('response.reasoning_summary_text.delta')
    expect(eventNames(sse)).toContain('response.reasoning_summary_part.done')
  })

  test('工具调用块产出 function_call_arguments 系列，call_id 透传', () => {
    const sse = encodeAll([
      {
        type: 'block_start',
        index: 0,
        block: { kind: 'tool_call', callId: 'call_1', name: 'shell' },
      },
      { type: 'block_delta', index: 0, delta: '{"cmd"' },
      { type: 'block_delta', index: 0, delta: ':"ls"}' },
      { type: 'block_end', index: 0 },
      { type: 'end', stopReason: 'tool_use' },
    ])
    expect(eventNames(sse)).toContain('response.function_call_arguments.delta')
    expect(sse).toContain('"call_id":"call_1"')
    expect(sse).toContain('"arguments":"{\\"cmd\\":\\"ls\\"}"')
  })

  const reasoningWithSignature: IrStreamEvent[] = [
    { type: 'block_start', index: 0, block: { kind: 'reasoning' } },
    { type: 'block_delta', index: 0, delta: '想' },
    {
      type: 'block_meta',
      index: 0,
      opaque: { protocol: 'anthropic.messages', payload: { signature: 'sig-x' } },
    },
    { type: 'block_end', index: 0 },
    { type: 'end', stopReason: 'completed' },
  ]

  test('preserveThinkingSignature 开启时，opaque 被封进 encrypted_content 带回客户端', () => {
    const sse = encodeAll(reasoningWithSignature, undefined, { preserveThinkingSignature: true })
    const match = /"encrypted_content":"([^"]+)"/.exec(sse)
    expect(match).not.toBeNull()
    expect(decodeOpaque(match![1])).toEqual({
      protocol: 'anthropic.messages',
      payload: { signature: 'sig-x' },
    })
  })

  test('默认不带 encrypted_content——它会被 codex 写进 rollout，关桥后毒死会话', () => {
    // codex 把这个字段永久存进 rollout；关桥后同一段历史发给 ChatGPT，它验签失败
    // 并拒绝整轮（`encrypted content ... could not be verified`），会话再也发不出消息。
    const sse = encodeAll(reasoningWithSignature)
    expect(sse).not.toContain('encrypted_content')
    // 推理文本本身照常回传，只是不带签名
    expect(sse).toContain('想')
  })

  test('output_index 按块开启顺序稠密递增', () => {
    const sse = encodeAll([
      { type: 'block_start', index: 5, block: { kind: 'reasoning' } },
      { type: 'block_end', index: 5 },
      { type: 'block_start', index: 9, block: { kind: 'text' } },
      { type: 'block_end', index: 9 },
      { type: 'end', stopReason: 'completed' },
    ])
    const indices = [...sse.matchAll(/"output_index":(\d+)/g)].map((m) => Number(m[1]))
    expect(new Set(indices)).toEqual(new Set([0, 1]))
  })

  test('恰好一个终止事件——end 之后再 push 全部无效', () => {
    const encoder = openaiResponsesCodec.createResponseEncoder({
      capabilities: DEFAULT_UPSTREAM_CAPABILITIES,
      model: 'm',
    })
    encoder.push({ type: 'block_start', index: 0, block: { kind: 'text' } })
    encoder.push({ type: 'block_end', index: 0 })
    const first = Buffer.concat(encoder.push({ type: 'end', stopReason: 'completed' })).toString()
    expect(eventNames(first).filter((n) => n === 'response.completed')).toHaveLength(1)
    expect(encoder.push({ type: 'block_delta', index: 0, delta: 'x' })).toEqual([])
    expect(encoder.finish('completed')).toEqual([])
  })

  test('上游没给终态就断流：已有内容按 max_tokens 收尾，不整轮报错', () => {
    const sse = encodeAll(
      [
        { type: 'block_start', index: 0, block: { kind: 'text' } },
        { type: 'block_delta', index: 0, delta: '半句话' },
      ],
      'truncated',
    )
    // 开着的块要补 done，保证 added/done 配对
    expect(eventNames(sse)).toContain('response.output_item.done')
    expect(eventNames(sse)).toContain('response.completed')
    expect(sse).toContain('"reason":"max_output_tokens"')
    expect(sse).toContain('半句话')
  })

  test('撞 max_tokens 且只有 reasoning：补一个文本 item，不让 codex 静默收工', () => {
    const sse = encodeAll([
      { type: 'block_start', index: 0, block: { kind: 'reasoning' } },
      { type: 'block_delta', index: 0, delta: '想了很久' },
      { type: 'block_end', index: 0 },
      { type: 'end', stopReason: 'max_tokens' },
    ])
    expect(sse).toContain('catmax bridge')
    expect(sse).toContain('max_tokens')
    // 补出来的必须是完整配对的 message item，否则 codex 侧解不出来
    expect(eventNames(sse).filter((n) => n === 'response.output_item.added')).toHaveLength(2)
    expect(eventNames(sse).filter((n) => n === 'response.output_item.done')).toHaveLength(2)
    expect(eventNames(sse).filter((n) => n === 'response.completed')).toHaveLength(1)
    expect(sse).toContain('"reason":"max_output_tokens"')
  })

  test('撞 max_tokens 但已有可见产出：不插旁白', () => {
    const sse = encodeAll([
      { type: 'block_start', index: 0, block: { kind: 'text' } },
      { type: 'block_delta', index: 0, delta: '正文' },
      { type: 'block_end', index: 0 },
      { type: 'end', stopReason: 'max_tokens' },
    ])
    expect(sse).not.toContain('catmax bridge')
    expect(eventNames(sse).filter((n) => n === 'response.output_item.done')).toHaveLength(1)
  })

  test('一个字都没吐就断流：报 failed 而不是伪装成功', () => {
    const sse = encodeAll([], 'truncated')
    expect(eventNames(sse)).toContain('response.failed')
  })

  test('error 事件转成 response.failed 并带上原因', () => {
    const sse = encodeAll([{ type: 'error', message: '上游 401', kind: 'auth_error' }])
    expect(eventNames(sse)).toContain('response.failed')
    expect(sse).toContain('上游 401')
  })

  test('usage 汇进 response.completed', () => {
    const sse = encodeAll([
      {
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 3, reasoningTokens: 5 },
      },
      { type: 'end', stopReason: 'completed' },
    ])
    expect(sse).toContain('"input_tokens":10')
    expect(sse).toContain('"output_tokens":20')
    expect(sse).toContain('"cached_tokens":3')
    expect(sse).toContain('"reasoning_tokens":5')
    expect(sse).toContain('"total_tokens":30')
  })

  test('response.completed 里带齐所有已完成的 output item', () => {
    const sse = encodeAll([
      { type: 'block_start', index: 0, block: { kind: 'text' } },
      { type: 'block_delta', index: 0, delta: '答案' },
      { type: 'block_end', index: 0 },
      { type: 'block_start', index: 1, block: { kind: 'tool_call', callId: 'c1', name: 'shell' } },
      { type: 'block_delta', index: 1, delta: '{}' },
      { type: 'block_end', index: 1 },
      { type: 'end', stopReason: 'tool_use' },
    ])
    const completed = sse.slice(sse.lastIndexOf('event: response.completed'))
    const payload = JSON.parse(completed.slice(completed.indexOf('data: ') + 6)) as {
      response: { output: Array<{ type: string }> }
    }
    expect(payload.response.output.map((item) => item.type)).toEqual(['message', 'function_call'])
  })
})
