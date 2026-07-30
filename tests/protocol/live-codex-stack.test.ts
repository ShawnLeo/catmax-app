// @vitest-environment node
// 临时全栈验证：真 codex app-server → 真 BridgeServer → 假 Anthropic 上游
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BridgeServer } from '@main/protocol/server'
import { DEFAULT_UPSTREAM_CAPABILITIES } from '@shared/protocol/codec'
import { afterAll, beforeAll, expect, test } from 'vitest'

const BIN = '/Users/shawn/Library/Application Support/catmax-app/backends/codex/0.146.0-darwin-x64/bin/codex'
function sse(e: string, d: unknown) { return `event: ${e}\ndata: ${JSON.stringify(d)}\n\n` }

let upstream: Server, bridge: BridgeServer, codex: ChildProcess
let upstreamModels: string[] = []
let lastMessageCount = 0

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      upstreamModels.push(String(body.model)); lastMessageCount = (body.messages||[]).length
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse('message_start', { message: { id: 'm1', model: body.model, usage: { input_tokens: 5 } } }))
      res.write(sse('content_block_start', { index: 0, content_block: { type: 'text' } }))
      res.write(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '收到' } }))
      res.write(sse('content_block_stop', { index: 0 }))
      res.write(sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }))
      res.write(sse('message_stop', {}))
      res.end()
    })
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
  const upUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`

  bridge = new BridgeServer({
    resolveUpstream: () => ({
      protocol: 'anthropic.messages', baseUrl: upUrl, apiKey: 'sk-up',
      model: 'deepseek-v4-pro',
      knownModelIds: new Set(['deepseek-v4-pro', 'deepseek-v4-flash']),
      capabilities: { ...DEFAULT_UPSTREAM_CAPABILITIES, supportsImages: false },
    }),
  })
  await bridge.start()

  codex = spawn(BIN, ['app-server', '--disable', 'apps',
    '-c', 'model_provider="catmax-bridge"',
    '-c', 'model_providers.catmax-bridge.name="bridge"',
    '-c', `model_providers.catmax-bridge.base_url="${bridge.baseUrl}"`,
    '-c', 'model_providers.catmax-bridge.wire_api="responses"',
    '-c', 'model_providers.catmax-bridge.env_key="CATMAX_BRIDGE_TOKEN"',
    '-c', 'model_providers.catmax-bridge.request_max_retries=0',
  ], { env: { ...process.env, CATMAX_BRIDGE_TOKEN: bridge.authToken } })
  codex.stderr!.on('data', (d) => console.log('CODEX_ERR:', String(d).slice(0, 400)))
})

afterAll(async () => {
  codex?.kill()
  await bridge?.stop()
  await new Promise<void>((r) => upstream.close(() => r()))
})

const pending = new Map<number, (v: any) => void>()
let buf = '', nextId = 1
function attach() {
  codex.stdout!.on('data', (d) => {
    buf += String(d)
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      try {
        const o = JSON.parse(line)
        if (o.id && pending.has(o.id)) { pending.get(o.id)!(o); pending.delete(o.id) }
        else if (o.method?.startsWith('turn') || o.method?.startsWith('item')) console.log('NOTIF:', o.method)
      } catch {}
    }
  })
}
function rpc(method: string, params: unknown, timeout = 25000): Promise<any> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, resolve)
    codex.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    setTimeout(() => reject(new Error(`timeout ${method}`)), timeout)
  })
}

test('历史 GPT 会话在桥模式下 resume 后继续', async () => {
  attach()
  await rpc('initialize', { clientInfo: { name: 'probe', title: 'p', version: '0.0.1' } })
  const thread = await rpc('thread/start', { cwd: process.cwd() })
  const threadId = thread.result?.threadId ?? thread.result?.thread?.id
  console.log('threadId:', threadId)

  // 第一轮：模拟"这个会话历史上用的是 gpt 模型"，rollout 里会记下 gpt-5.2-codex
  await rpc('turn/start', { threadId, model: 'gpt-5.2-codex', input: [{ type: 'text', text: '第一轮' }] })
  await new Promise((r) => setTimeout(r, 3000))
  console.log('第一轮上游收到:', upstreamModels)

  // 模拟 app 重启：resume 同一个 thread，再发一轮，仍然带着历史里的 gpt 模型名
  const resumed = await rpc('thread/resume', { threadId })
  console.log('resume ok:', JSON.stringify(resumed).slice(0, 200))

  const t2 = await rpc('turn/start', { threadId, model: 'gpt-5.2-codex', input: [{ type: 'text', text: '第二轮' }] })
  console.log('第二轮 turn/start:', JSON.stringify(t2).slice(0, 300))
  await new Promise((r) => setTimeout(r, 4000))
  console.log('全部上游收到的模型名:', upstreamModels)
  console.log('第二轮请求里的消息条数:', lastMessageCount)
  expect(upstreamModels).toEqual(['deepseek-v4-pro', 'deepseek-v4-pro'])
}, 90000)
