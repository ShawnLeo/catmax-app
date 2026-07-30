// @vitest-environment node
/**
 * 跨上游续聊：一个先前跑在真 ChatGPT 上的会话，开桥后改打 DeepSeek。
 *
 * codex 每轮都把完整历史重发一遍（store:false，不用 previous_response_id），所以
 * 历史里那些 **OpenAI 的** reasoning item 会连着它们的 `encrypted_content` 一起被
 * 送进桥。那串密文只有 OpenAI 解得开，对 Anthropic 上游毫无意义且必然 400——
 * 这里钉住它的降级行为：不能抛、不能把密文漏给新上游、但要保住上下文语义。
 */
import { encodeAnthropicRequest } from '@main/protocol/codecs/anthropic-messages'
import { decodeResponsesRequest, encodeOpaque } from '@main/protocol/codecs/openai-responses'
import { DEFAULT_UPSTREAM_CAPABILITIES, type UpstreamCapabilities } from '@shared/protocol/codec'
import { describe, expect, test } from 'vitest'

const DEEPSEEK_CAPS: UpstreamCapabilities = {
  ...DEFAULT_UPSTREAM_CAPABILITIES,
  supportsImages: false,
}

/** OpenAI 真实回放里的密文——base64 样子的黑盒，不带我们的 catmax-bridge-v1: 前缀 */
const OPENAI_BLOB = 'gAAAAABm9Xk3_openai_encrypted_reasoning_payload_'

/** 一个"历史上跑在 ChatGPT 上"的 Responses 请求：思考 + 工具调用 + 工具结果俱全 */
function gptHistoryRequest(): Record<string, unknown> {
  return {
    model: 'gpt-5.2-codex',
    instructions: 'You are Codex.',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '列一下目录' }] },
      {
        type: 'reasoning',
        id: 'rs_abc123',
        summary: [{ type: 'summary_text', text: '先看看当前目录' }],
        encrypted_content: OPENAI_BLOB,
      },
      { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"cmd":"ls"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'a.txt\nb.txt' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '再看看大小' }] },
    ],
    tools: [
      { type: 'function', name: 'shell', description: '跑命令', parameters: { type: 'object' } },
    ],
    reasoning: { effort: 'medium' },
    stream: true,
    store: false,
  }
}

describe('GPT 历史会话切到 Anthropic 上游', () => {
  test('不抛异常，历史结构完整保留', () => {
    const ir = decodeResponsesRequest(gptHistoryRequest())
    const body = encodeAnthropicRequest(ir, DEEPSEEK_CAPS) as Record<string, unknown>

    expect(body.system).toBe('You are Codex.')
    // 工具调用链没断：tool_use 和它的 tool_result 都还在
    const json = JSON.stringify(body)
    expect(json).toContain('tool_use')
    expect(json).toContain('tool_result')
    expect(json).toContain('call_1')
    expect(json).toContain('a.txt')
  })

  test('OpenAI 的密文绝不会被转发给新上游', () => {
    const ir = decodeResponsesRequest(gptHistoryRequest())
    const body = encodeAnthropicRequest(ir, DEEPSEEK_CAPS)
    // 解不开的密文只能丢掉——原样发过去上游必然报签名不合法
    expect(JSON.stringify(body)).not.toContain(OPENAI_BLOB)
  })

  test('思考内容降级成普通文本，上下文语义不丢', () => {
    const ir = decodeResponsesRequest(gptHistoryRequest())
    const body = encodeAnthropicRequest(ir, DEEPSEEK_CAPS) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>
    }

    const blocks = body.messages.flatMap((m) => m.content)
    // 没有签名的 thinking 块会被 Anthropic 拒，所以必须降级成 text 而不是原样发
    expect(blocks.some((b) => b.type === 'thinking')).toBe(false)
    expect(blocks.some((b) => b.type === 'text' && b.text === '先看看当前目录')).toBe(true)
  })

  test('对照组：本桥自己写的 opaque 能还原成带签名的 thinking', () => {
    // 同一条通路，区别只在 encrypted_content 是不是我们上一轮塞进去的封装
    const request = gptHistoryRequest()
    const input = request.input as Array<Record<string, unknown>>
    input[1]!.encrypted_content = encodeOpaque({
      protocol: 'anthropic.messages',
      payload: { signature: 'sig-real' },
    })

    const ir = decodeResponsesRequest(request)
    const body = encodeAnthropicRequest(ir, DEEPSEEK_CAPS) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>
    }
    const thinking = body.messages.flatMap((m) => m.content).find((b) => b.type === 'thinking') as
      { signature?: string } | undefined
    expect(thinking?.signature).toBe('sig-real')
  })

  test('codex 内置的 gpt-* 模型名会被兜底名顶掉（resolveModel 的职责，此处仅记录期望）', () => {
    const ir = decodeResponsesRequest(gptHistoryRequest())
    // 解码阶段原样保留；改写发生在 bridge.ts 的 resolveModel，见 bridge-e2e 的用例
    expect(ir.model).toBe('gpt-5.2-codex')
  })
})
