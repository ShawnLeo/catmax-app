/**
 * Protocol Bridge 本地 HTTP 服务。
 *
 * 对 codex 装成一个 Responses 端点，对上游说上游的协议。
 *
 * 安全边界（这是本机上的一个转发口，必须收紧）：
 * - 只绑 127.0.0.1，端口由系统随机分配，不写死；
 * - 每次启动生成一次性 token，请求必须带对；codex 侧通过 config.toml 的
 *   `env_key` 拿到这个 token——**上游的真 key 从不进 codex 的环境或配置**；
 * - 只开放白名单路径，其余一律 404；
 * - 不记录任何请求体（里面是用户的完整代码和对话）。
 */
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { BridgeUpstreamProtocol } from '@shared/protocol/bridge-config'
import { BRIDGE_CLIENT_PROTOCOL } from '@shared/protocol/bridge-config'
import { BridgeRequestError } from '@shared/protocol/codec'

import { logger } from '../service/logger'

import { runBridgeTurn, type BridgeUpstreamTarget } from './bridge'

const log = logger.domain('bridge-server')

/** 请求体上限。Responses 请求会带完整对话历史，给得宽一点，但不能无上限。 */
const MAX_REQUEST_BYTES = 32 * 1024 * 1024

export interface BridgeServerOptions {
  /** 每次请求时解析当前上游配置——设置改了不用重启服务 */
  resolveUpstream: () => BridgeUpstreamTarget | null
}

export class BridgeServer {
  private server: Server | null = null
  private port: number | null = null
  private readonly token = randomBytes(32).toString('base64url')
  private lastError: string | null = null

  constructor(private readonly options: BridgeServerOptions) {}

  get authToken(): string {
    return this.token
  }

  get listenPort(): number | null {
    return this.port
  }

  get error(): string | null {
    return this.lastError
  }

  get running(): boolean {
    return this.server !== null && this.port !== null
  }

  /** 写进 codex config.toml 的 base_url */
  get baseUrl(): string | null {
    return this.port === null ? null : `http://127.0.0.1:${this.port}/v1`
  }

  async start(): Promise<void> {
    if (this.server) return

    const server = createServer((req, res) => {
      void this.handle(req, res)
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.lastError = error.message
        reject(error)
      }
      server.once('error', onError)
      // 端口传 0 让内核分配；只绑回环地址，局域网访问不到
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', onError)
        resolve()
      })
    })

    this.server = server
    this.port = (server.address() as AddressInfo).port
    this.lastError = null
    log.info('bridge listening', this.baseUrl)
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    this.port = null
    await new Promise<void>((resolve) => server.close(() => resolve()))
    log.info('bridge stopped')
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0] ?? ''

    if (req.method === 'GET' && path === '/health') {
      return sendJson(res, 200, { ok: true })
    }

    // codex 0.145+ 的 models manager 启动时会 GET <base_url>/models 刷新远程模型列表，
    // 失败（404）虽然不致命（有本地缓存兜底），但会刷屏报错。桥不是真正的模型仓库——
    // 直接把上游配置里的模型名回出去即可。
    //
    // 格式必须严格对照 codex 自己的 ~/.codex/models_cache.json——codex 用 serde 逐字段
    // 反序列化，缺任一必填字段就报 "missing field"。这套字段是 codex 自家的（非标准
    // OpenAI 的 {data:[...]}），且随版本变化，所以这里返回完整的模型对象（实测逐字段
    // 确认过的），把上游模型名填进去即可，不给 DeepSeek 不支持的功能（图片/思考档位）。
    if (req.method === 'GET' && ['/v1/models', '/models'].includes(path)) {
      if (!this.checkAuth(req)) {
        return sendJson(res, 401, { error: { message: '桥的 token 不匹配' } })
      }
      const upstream = this.options.resolveUpstream()
      // 没配上游时返回占位模型而非报错——codex 会回退到内置模型缓存
      const modelId = upstream?.model ?? 'catmax-bridge'
      return sendJson(res, 200, { models: [bridgeModelEntry(modelId)] })
    }

    // codex 可能带或不带 /v1 前缀；compact 端点也走同一套转换
    const isResponses =
      req.method === 'POST' &&
      ['/v1/responses', '/responses', '/v1/responses/compact', '/responses/compact'].includes(path)

    if (!isResponses) {
      return sendJson(res, 404, { error: { message: `桥不处理该路径：${req.method} ${path}` } })
    }

    if (!this.checkAuth(req)) {
      return sendJson(res, 401, { error: { message: '桥的 token 不匹配' } })
    }

    const upstream = this.options.resolveUpstream()
    if (!upstream) {
      return sendJson(res, 503, {
        error: { message: '协议桥未配置上游（缺 base_url 或 API key），请到设置里补全' },
      })
    }

    let body: unknown
    try {
      body = JSON.parse(await readBody(req))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return sendJson(res, 400, { error: { message: `请求体解析失败：${message}` } })
    }

    const controller = new AbortController()
    // codex 中断这一轮时会直接断连接，要把中断传导到上游，不然上游会一直烧 token
    res.on('close', () => controller.abort())

    try {
      const result = await runBridgeTurn({
        clientProtocol: BRIDGE_CLIENT_PROTOCOL,
        upstream,
        requestBody: body,
        signal: controller.signal,
      })

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })

      for await (const frame of result.stream) {
        if (res.writableEnded) break
        res.write(frame)
      }
      res.end()
    } catch (error) {
      if (controller.signal.aborted) {
        if (!res.writableEnded) res.end()
        return
      }
      const status = error instanceof BridgeRequestError ? error.status : 500
      const message = error instanceof Error ? error.message : String(error)
      log.warn('bridge request failed', message)
      if (res.headersSent) {
        if (!res.writableEnded) res.end()
        return
      }
      sendJson(res, status, { error: { message } })
    }
  }

  /** codex 用 `Authorization: Bearer <env_key 的值>` 发过来；也兼容 x-api-key */
  private checkAuth(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    const bearer = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '').trim() : ''
    const apiKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : ''
    return safeEqual(bearer, this.token) || safeEqual(apiKey, this.token)
  }
}

/** 定长比较，避免时序侧信道。长度不等直接 false（长度本身不是秘密）。 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) {
      throw new BridgeRequestError('请求体超过 32MB 上限', 413)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 构造 codex /v1/models 端点返回的单个模型对象。
 *
 * 字段集严格对照 codex 自己的 ~/.codex/models_cache.json——codex 用 serde 逐字段
 * 反序列化，缺任一必填字段就报 "missing field"。这套字段是 codex 自家的（非标准
 * OpenAI 格式），且随版本增长，所以这里返回完整对象（34 字段，实测确认过的），
 * 只把上游模型名填进 slug/display_name/description。DeepSeek 不支持的能力（图片、
 * 思考档位）给保守值，确保 codex 不会尝试发送不支持的请求。
 */
function bridgeModelEntry(modelId: string): Record<string, unknown> {
  return {
    slug: modelId,
    display_name: modelId,
    description: `${modelId} via catmax protocol bridge`,
    // DeepSeek 不支持 reasoning levels（capabilities.respectsThinkingBudget=false），
    // 但 codex 要这些字段是字符串/数组而非 null，给空挡位
    default_reasoning_level: 'low',
    supported_reasoning_levels: [],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    service_tiers: [],
    // 这两个字段在 models_cache.json 里就是 null（可选）
    availability_nux: null,
    upgrade: null,
    base_instructions: '',
    model_messages: { instructions_template: '' },
    include_skills_usage_instructions: false,
    default_reasoning_summary: 'none',
    support_verbosity: false,
    default_verbosity: 'low',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'disabled',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: false,
    context_window: 128000,
    max_context_window: 128000,
    comp_hash: '',
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    // DeepSeek Anthropic 兼容端点不支持图片输入
    input_modalities: ['text'],
    supports_search_tool: false,
    use_responses_lite: true,
    tool_mode: 'default',
    multi_agent_version: 'v2',
  }
}

export type { BridgeUpstreamProtocol }
