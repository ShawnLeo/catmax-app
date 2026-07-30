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

    // GET /models 故意**不实现**（落到下面的 404）。
    //
    // codex 的 models manager 会来刷新远程模型列表，这里曾经手工伪造过一份它自己的
    // `models_cache.json`（34 个字段）回给它。那是个错误的方向：那份 schema 是 codex 私有的、
    // 无文档的，且随版本漂移——0.146 就因为其中一个字段的取值报了
    //   `unknown variant \`disabled\`, expected \`text\` or \`text_and_image\``
    // 直接把整次刷新打成 ERROR。伪造一份**会解码失败**的响应，比压根不提供这个端点更糟。
    //
    // 404 是所有第三方 provider 的常规路径（没人实现 codex 的私有端点），codex 有内置目录
    // 兜底，这条分支被验证得最充分。catmax 侧也早已不依赖 codex 的模型列表——桥开着时
    // 下拉框直接读上游（见 CodexAdapter.setModelListProvider），所以这里没有任何损失。

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

export type { BridgeUpstreamProtocol }
