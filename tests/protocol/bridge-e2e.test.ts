// @vitest-environment node
/**
 * 端到端：起一个假的 Anthropic 上游 + 真的 BridgeServer，
 * 用 Responses 请求打进去，验证吐出来的是合法的 Responses SSE。
 *
 * 覆盖单元测试碰不到的部分：token 鉴权、路径路由、上游转发、字节流管道、错误映射。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { BridgeServer } from '@main/protocol/server'
import { DEFAULT_UPSTREAM_CAPABILITIES } from '@shared/protocol/codec'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

interface FakeUpstream {
  server: Server
  url: string
  /** 收到的请求体，供断言请求侧转换 */
  lastBody: Record<string, unknown> | null
  lastHeaders: Record<string, string | string[] | undefined>
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** 假上游：按 script 逐帧吐 SSE；status 非 200 时直接返回错误体 */
async function startFakeUpstream(options: {
  script?: string[]
  status?: number
  errorBody?: unknown
}): Promise<FakeUpstream> {
  const state: FakeUpstream = {
    server: null as unknown as Server,
    url: '',
    lastBody: null,
    lastHeaders: {},
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      state.lastHeaders = req.headers
      try {
        state.lastBody = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<
          string,
          unknown
        >
      } catch {
        state.lastBody = null
      }

      const status = options.status ?? 200
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(options.errorBody ?? { error: { message: 'nope' } }))
        return
      }

      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const frame of options.script ?? []) res.write(frame)
      res.end()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  state.server = server
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return state
}

const DEFAULT_SCRIPT = [
  sse('message_start', {
    message: { id: 'msg_1', model: 'deepseek-v4-pro', usage: { input_tokens: 11 } },
  }),
  sse('content_block_start', { index: 0, content_block: { type: 'thinking' } }),
  sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '想一下' } }),
  sse('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig-9' } }),
  sse('content_block_stop', { index: 0 }),
  sse('content_block_start', { index: 1, content_block: { type: 'text' } }),
  sse('content_block_delta', { index: 1, delta: { type: 'text_delta', text: '你好' } }),
  sse('content_block_stop', { index: 1 }),
  sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 22 } }),
  sse('message_stop', {}),
]

const RESPONSES_REQUEST = {
  model: 'gpt-5-codex',
  instructions: 'You are Codex.',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '在吗' }] }],
  tools: [
    { type: 'function', name: 'shell', description: '跑命令', parameters: { type: 'object' } },
  ],
  reasoning: { effort: 'medium' },
  stream: true,
  store: false,
}

let upstream: FakeUpstream | null = null
let bridge: BridgeServer | null = null

afterEach(async () => {
  await bridge?.stop()
  bridge = null
  await new Promise<void>((resolve) => {
    if (!upstream) return resolve()
    upstream.server.close(() => resolve())
  })
  upstream = null
})

async function startBridge(
  target: FakeUpstream,
  model: string | null = null,
): Promise<BridgeServer> {
  const server = new BridgeServer({
    resolveUpstream: () => ({
      protocol: 'anthropic.messages',
      baseUrl: target.url,
      apiKey: 'sk-upstream',
      model,
      capabilities: { ...DEFAULT_UPSTREAM_CAPABILITIES, supportsImages: false },
    }),
  })
  await server.start()
  return server
}

async function callBridge(
  server: BridgeServer,
  body: unknown,
  token = server.authToken,
): Promise<{ status: number; text: string }> {
  const response = await fetch(`${server.baseUrl}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: response.status, text: await response.text() }
}

function eventNames(text: string): string[] {
  return [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]!)
}

describe('BridgeServer 端到端', () => {
  beforeEach(async () => {
    upstream = await startFakeUpstream({ script: DEFAULT_SCRIPT })
    bridge = await startBridge(upstream)
  })

  test('只绑回环地址且端口随机', () => {
    expect(bridge!.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    expect(bridge!.listenPort).toBeGreaterThan(0)
  })

  test('token 不对直接 401，不转发到上游', async () => {
    const result = await callBridge(bridge!, RESPONSES_REQUEST, 'wrong-token')
    expect(result.status).toBe(401)
    expect(upstream!.lastBody).toBeNull()
  })

  test('未知路径 404', async () => {
    const response = await fetch(`${bridge!.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bridge!.authToken}` },
      body: '{}',
    })
    expect(response.status).toBe(404)
  })

  test('/health 不需要 token', async () => {
    const response = await fetch(`http://127.0.0.1:${bridge!.listenPort}/health`)
    expect(response.status).toBe(200)
  })

  test('/v1/models 返回上游模型（codex 期望的 {models:[...]} 格式，非 data）', async () => {
    // codex 0.145+ 的 models manager 会 GET <base_url>/models 刷新模型列表。
    // 它期望字段是 `models`（实测返回 {data:[...]} 会报 missing field `models`）。
    const response = await fetch(`${bridge!.baseUrl}/models`, {
      headers: { authorization: `Bearer ${bridge!.authToken}` },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { models: Array<{ slug: string }> }
    expect(body.models).toBeInstanceOf(Array)
    expect(body.models.length).toBeGreaterThan(0)
    expect(body.models[0]!.slug).toBeDefined()
  })

  test('/v1/models 没 token → 401', async () => {
    const response = await fetch(`${bridge!.baseUrl}/models`)
    expect(response.status).toBe(401)
  })

  test('请求侧：Responses → Anthropic 转换正确', async () => {
    await callBridge(bridge!, RESPONSES_REQUEST)

    expect(upstream!.lastBody).toMatchObject({
      model: 'gpt-5-codex',
      system: 'You are Codex.',
      stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: '在吗' }] }],
      thinking: { type: 'enabled', budget_tokens: 8192 },
    })
    // max_tokens 是 Anthropic 必填项
    expect(typeof upstream!.lastBody!.max_tokens).toBe('number')
    // 工具被翻成 Anthropic 的 input_schema 形态
    expect(upstream!.lastBody!.tools).toEqual([
      { name: 'shell', description: '跑命令', input_schema: { type: 'object' } },
    ])
    // 上游真 key 走 x-api-key，而不是 codex 发来的桥 token
    expect(upstream!.lastHeaders['x-api-key']).toBe('sk-upstream')
    expect(upstream!.lastHeaders['anthropic-version']).toBe('2023-06-01')
  })

  test('上游真 key 绝不会等于桥的 token（凭证隔离）', async () => {
    await callBridge(bridge!, RESPONSES_REQUEST)
    expect(upstream!.lastHeaders['x-api-key']).not.toBe(bridge!.authToken)
    expect(JSON.stringify(upstream!.lastHeaders)).not.toContain(bridge!.authToken)
  })

  test('响应侧：Anthropic SSE → 合法的 Responses SSE', async () => {
    const result = await callBridge(bridge!, RESPONSES_REQUEST)
    expect(result.status).toBe(200)

    const names = eventNames(result.text)
    expect(names[0]).toBe('response.created')
    expect(names[1]).toBe('response.in_progress')
    expect(names.at(-1)).toBe('response.completed')

    // reasoning 和 text 各自成 item，added/done 严格配对
    expect(names.filter((n) => n === 'response.output_item.added')).toHaveLength(2)
    expect(names.filter((n) => n === 'response.output_item.done')).toHaveLength(2)
    expect(names).toContain('response.reasoning_summary_text.delta')
    expect(names).toContain('response.output_text.delta')

    expect(result.text).toContain('想一下')
    expect(result.text).toContain('你好')
    // 用量透传
    expect(result.text).toContain('"input_tokens":11')
    expect(result.text).toContain('"output_tokens":22')
  })

  test('思考签名被封进 encrypted_content 带回客户端', async () => {
    const result = await callBridge(bridge!, RESPONSES_REQUEST)
    expect(result.text).toContain('"encrypted_content":"catmax-bridge-v1:')
  })

  test('终止事件恰好一个', async () => {
    const result = await callBridge(bridge!, RESPONSES_REQUEST)
    const terminal = eventNames(result.text).filter(
      (n) => n === 'response.completed' || n === 'response.failed',
    )
    expect(terminal).toHaveLength(1)
  })

  test('请求体不是 JSON 时 400', async () => {
    const response = await fetch(`${bridge!.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bridge!.authToken}` },
      body: '{ 坏掉的 json',
    })
    expect(response.status).toBe(400)
  })
})

describe('BridgeServer 异常路径', () => {
  test('上游 4xx 转成 response.failed 并带上上游原文，而不是桥自己 500', async () => {
    upstream = await startFakeUpstream({
      status: 401,
      errorBody: { error: { type: 'authentication_error', message: 'invalid x-api-key' } },
    })
    bridge = await startBridge(upstream)

    const result = await callBridge(bridge, RESPONSES_REQUEST)
    // 桥自己是 200——错误通过 SSE 事件告诉 codex，否则 codex 只会显示一个干巴巴的 HTTP 错
    expect(result.status).toBe(200)
    expect(eventNames(result.text)).toContain('response.failed')
    expect(result.text).toContain('invalid x-api-key')
    expect(result.text).toContain('401')
  })

  test('上游流没给终态就断掉：已有内容按完成收尾，不丢内容', async () => {
    upstream = await startFakeUpstream({
      script: [
        sse('message_start', { message: { id: 'm', model: 'x', usage: { input_tokens: 1 } } }),
        sse('content_block_start', { index: 0, content_block: { type: 'text' } }),
        sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '半句' } }),
        // 没有 content_block_stop / message_stop，直接断
      ],
    })
    bridge = await startBridge(upstream)

    const result = await callBridge(bridge, RESPONSES_REQUEST)
    const names = eventNames(result.text)
    expect(result.text).toContain('半句')
    // 开着的 item 被补上 done
    expect(names.filter((n) => n === 'response.output_item.added')).toHaveLength(1)
    expect(names.filter((n) => n === 'response.output_item.done')).toHaveLength(1)
    expect(names.at(-1)).toBe('response.completed')
    expect(result.text).toContain('max_output_tokens')
  })

  test('上游一个字都没吐就断：报 failed，不伪装成功', async () => {
    upstream = await startFakeUpstream({ script: [] })
    bridge = await startBridge(upstream)

    const result = await callBridge(bridge, RESPONSES_REQUEST)
    expect(eventNames(result.text)).toContain('response.failed')
  })

  test('配置了 model 覆盖时用覆盖值，而不是 codex 发来的模型名', async () => {
    upstream = await startFakeUpstream({ script: DEFAULT_SCRIPT })
    bridge = await startBridge(upstream, 'deepseek-v4-pro')

    await callBridge(bridge, RESPONSES_REQUEST)
    expect(upstream.lastBody!.model).toBe('deepseek-v4-pro')
  })

  test('上游没配好时回 503 并给人话提示', async () => {
    const server = new BridgeServer({ resolveUpstream: () => null })
    await server.start()
    try {
      const result = await callBridge(server, RESPONSES_REQUEST)
      expect(result.status).toBe(503)
      expect(result.text).toContain('未配置上游')
    } finally {
      await server.stop()
    }
  })
})

describe('多轮工具循环', () => {
  test('第二轮把 thinking 签名和工具结果原样带回上游', async () => {
    upstream = await startFakeUpstream({ script: DEFAULT_SCRIPT })
    bridge = await startBridge(upstream)

    // 模拟 codex 拿到第一轮结果后的第二轮请求：带 reasoning item（含我们塞的封装）、
    // function_call 和 function_call_output
    const first = await callBridge(bridge, RESPONSES_REQUEST)
    const encrypted = /"encrypted_content":"([^"]+)"/.exec(first.text)![1]!

    await callBridge(bridge, {
      ...RESPONSES_REQUEST,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '在吗' }] },
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: '想一下' }],
          encrypted_content: encrypted,
        },
        { type: 'function_call', call_id: 'call_7', name: 'shell', arguments: '{"cmd":"ls"}' },
        { type: 'function_call_output', call_id: 'call_7', output: 'a.txt' },
      ],
    })

    const messages = upstream.lastBody!.messages as Array<{
      role: string
      content: Array<Record<string, unknown>>
    }>
    // user(问题) / assistant(thinking + tool_use) / user(tool_result)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[1]!.content[0]).toEqual({
      type: 'thinking',
      thinking: '想一下',
      signature: 'sig-9',
    })
    expect(messages[1]!.content[1]).toMatchObject({ type: 'tool_use', id: 'call_7', name: 'shell' })
    expect(messages[2]!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_7' })
  })
})
