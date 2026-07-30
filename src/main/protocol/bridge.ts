/**
 * Protocol Bridge 编排层：把「客户端 codec」和「上游 codec」接起来。
 *
 *   codex ──Responses请求──▶ decodeRequest ──IR──▶ encodeRequest ──▶ 上游
 *   codex ◀──Responses SSE── ResponseEncoder ◀─IR─ StreamDecoder ◀── 上游
 *
 * 这一层不认识任何具体协议，只负责：转发、错误归一、以及那条硬不变量——
 * **无论上游怎么断，客户端一定收到恰好一个终止事件**。
 */
import { BridgeRequestError, type UpstreamCapabilities } from '@shared/protocol/codec'
import type { ProtocolId } from '@shared/protocol/ir'

import { logger } from '../service/logger'

import { getCodec } from './registry'

const log = logger.domain('bridge')

export interface BridgeUpstreamTarget {
  protocol: ProtocolId
  baseUrl: string
  apiKey: string
  /** 兜底模型名，客户端发来的模型名不被上游认识时用它。null 表示一律透传 */
  model: string | null
  /** 上游确实存在的模型 id；null 表示还没拉到列表（此时一律用兜底名） */
  knownModelIds?: ReadonlySet<string> | null
  capabilities: UpstreamCapabilities
}

export interface BridgeTurnOptions {
  clientProtocol: ProtocolId
  upstream: BridgeUpstreamTarget
  requestBody: unknown
  /** 上游请求的额外头（代理场景下的 UA 等） */
  extraHeaders?: Record<string, string>
  signal: AbortSignal
}

export interface BridgeTurnResult {
  /** 要写给客户端的 SSE 字节流 */
  stream: AsyncIterable<Buffer>
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  // base_url 已经带了具体路径（如 .../anthropic）时不重复拼 /v1
  const suffix = /\/v\d+$/.test(base) ? path.replace(/^\/v\d+/, '') : path
  return base + suffix
}

/**
 * 决定最终发给上游的模型名。
 *
 * codex 会发两类模型名：一类是用户在 catmax 下拉框里选的（桥开着时这个列表来自上游，
 * 是真实存在的模型），一类是 codex 自己编译进二进制的 ChatGPT 目录里的名字
 * （gpt-5.6-sol 等，上游根本不认，原样发过去必然 400）。
 *
 * 所以：**认识就透传，不认识才用兜底名**。拉不到上游列表时（knownModelIds 为 null）
 * 保守地一律用兜底名——那是旧版行为，至少能保证请求打得通。
 */
function resolveModel(requested: string, upstream: BridgeUpstreamTarget): string {
  const known = upstream.knownModelIds
  if (known && known.has(requested)) return requested
  return upstream.model ?? requested
}

/**
 * 跑一整轮桥接。
 *
 * 返回的 stream 是惰性的：调用方 for-await 消费时才真正发起上游请求。
 */
export async function runBridgeTurn(options: BridgeTurnOptions): Promise<BridgeTurnResult> {
  const clientCodec = getCodec(options.clientProtocol)
  const upstreamCodec = getCodec(options.upstream.protocol)

  const ir = clientCodec.decodeRequest(options.requestBody)
  ir.model = resolveModel(ir.model, options.upstream)

  const upstreamBody = upstreamCodec.encodeRequest(ir, options.upstream.capabilities)
  const url = joinUrl(options.upstream.baseUrl, upstreamCodec.upstreamPath())

  log.info('bridge turn', {
    client: options.clientProtocol,
    upstream: options.upstream.protocol,
    model: ir.model,
    messages: ir.messages.length,
    tools: ir.tools.length,
    thinking: ir.reasoning.enabled,
  })

  const encoder = clientCodec.createResponseEncoder({ model: ir.model })

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: ir.stream ? 'text/event-stream' : 'application/json',
      ...upstreamCodec.authHeaders(options.upstream.apiKey),
      ...options.extraHeaders,
    },
    body: JSON.stringify(upstreamBody),
    signal: options.signal,
  })

  if (!response.ok) {
    const detail = await safeReadText(response)
    // 上游的 4xx/5xx 不能变成桥的 500——原样把信息带给 codex，用户才知道是
    // key 过期还是模型名不对。
    const message = `上游返回 ${response.status}：${detail.slice(0, 2000)}`
    log.warn('upstream error', { status: response.status, detail: detail.slice(0, 500) })
    return { stream: toStream(encoder.finish('error', message)) }
  }

  if (!ir.stream || !response.body) {
    const body: unknown = await response.json().catch(() => null)
    const frames: Buffer[] = []
    for (const event of upstreamCodec.decodeResponse(body)) {
      frames.push(...encoder.push(event))
    }
    frames.push(...encoder.finish('completed'))
    return { stream: toStream(frames) }
  }

  return { stream: pipe(response.body, upstreamCodec, encoder) }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return '(无法读取响应体)'
  }
}

function toStream(frames: Buffer[]): AsyncIterable<Buffer> {
  return (async function* () {
    for (const frame of frames) yield frame
  })()
}

/**
 * 上游字节流 → IR 事件 → 客户端字节流。
 *
 * 三种收尾路径都要保证恰好一个终止事件：
 * 1. 上游正常给了 end 事件 → encoder 自己终止，finish() 变 no-op；
 * 2. 上游流没给终态就 EOF → finish('truncated')，已有内容按 max_tokens 收尾；
 * 3. 传输层抛异常 → finish('error')。
 */
async function* pipe(
  body: ReadableStream<Uint8Array>,
  upstreamCodec: ReturnType<typeof getCodec>,
  encoder: ReturnType<ReturnType<typeof getCodec>['createResponseEncoder']>,
): AsyncIterable<Buffer> {
  const decoder = upstreamCodec.createStreamDecoder()
  const reader = body.getReader()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (const event of decoder.push(Buffer.from(value))) {
        for (const frame of encoder.push(event)) yield frame
      }
    }
    for (const event of decoder.finish()) {
      for (const frame of encoder.push(event)) yield frame
    }
    for (const frame of encoder.finish('truncated')) yield frame
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('bridge stream aborted', message)
    for (const frame of encoder.finish('error', `上游流中断：${message}`)) yield frame
  } finally {
    reader.releaseLock()
  }
}

export { BridgeRequestError }
