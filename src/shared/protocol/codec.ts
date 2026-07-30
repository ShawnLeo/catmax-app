/**
 * Protocol Bridge codec 契约。
 *
 * 一个 codec 描述「某个协议」的两侧能力：
 * - 客户端侧：把客户端发来的请求解成 IR（decodeRequest）、把 IR 事件流编成该协议的
 *   SSE 字节（createResponseEncoder）；
 * - 上游侧：把 IR 编成发给上游的请求体（encodeRequest）、把上游的 SSE 字节解成
 *   IR 事件（createStreamDecoder）。
 *
 * 任意两个 codec 组合就是一条转换通路，N 个协议自动获得 N² 个组合。
 *
 * encoder / decoder 都是**有状态对象**而不是纯函数：Responses 的 added/done 配对、
 * 块索引分配、上游断流时的终态合成，本质都需要跨事件的状态。
 */
import type { IrRequest, IrStreamEvent, IrUsage, ProtocolId } from './ir'

/** 上游的能力/怪癖声明。是数据不是分支——加一家上游只加一条配置。 */
export interface UpstreamCapabilities {
  /** 不支持图片时，图片块降级成文字占位而不是原样发过去触发 400 */
  supportsImages: boolean
  /** 上游忽略 thinking budget（DeepSeek 就是），据此决定要不要费劲算 budget */
  respectsThinkingBudget: boolean
  /** 开启思考时是否必须去掉 temperature / top_p（Anthropic 系的硬约束） */
  dropSamplingWhenThinking: boolean
  /** 上游要求 max_tokens 必填时的兜底值 */
  defaultMaxOutputTokens: number
  /** 工具名长度上限，超了要截断并建立映射 */
  toolNameMaxLength: number
}

export const DEFAULT_UPSTREAM_CAPABILITIES: UpstreamCapabilities = {
  supportsImages: true,
  respectsThinkingBudget: true,
  dropSamplingWhenThinking: true,
  defaultMaxOutputTokens: 8192,
  toolNameMaxLength: 64,
}

/**
 * 把 IR 事件编成客户端协议的 SSE 字节。
 *
 * `finish()` 是硬性契约：**无论上游怎么断，客户端必须恰好收到一个终止事件**。
 * 这和 PerTurnCoordinator 的 exactly-one-terminal-event 是同一条不变量。
 */
export interface ResponseEncoder {
  push(event: IrStreamEvent): Buffer[]
  /** 上游流没给终态就断了时调用，合成终止事件。已经终止过则返回空数组。 */
  finish(reason: 'completed' | 'truncated' | 'error', message?: string): Buffer[]
}

/** 把上游协议的 SSE 字节解成 IR 事件 */
export interface StreamDecoder {
  push(chunk: Buffer): IrStreamEvent[]
  /** 流结束时冲刷残留缓冲 */
  finish(): IrStreamEvent[]
}

export interface ProtocolCodec {
  readonly id: ProtocolId

  // ── 客户端侧 ──
  /** 解析客户端请求体。入参是不可信输入，解析失败必须抛 BridgeRequestError。 */
  decodeRequest(body: unknown): IrRequest
  createResponseEncoder(ctx: { model: string }): ResponseEncoder

  // ── 上游侧 ──
  encodeRequest(ir: IrRequest, caps: UpstreamCapabilities): unknown
  createStreamDecoder(): StreamDecoder
  /** 上游走非流式时，把整个响应体归一成同一组事件 */
  decodeResponse(body: unknown): IrStreamEvent[]

  /** 相对 base_url 的请求路径，如 '/v1/messages' */
  upstreamPath(): string
  /** 凭证注入方式，各协议不同（Bearer vs x-api-key + anthropic-version） */
  authHeaders(apiKey: string): Record<string, string>
}

/** 客户端请求体不合法。会被 server 映射成 4xx。 */
export class BridgeRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'BridgeRequestError'
  }
}

export function usageFrom(partial: Partial<IrUsage>): IrUsage {
  return {
    inputTokens: partial.inputTokens ?? 0,
    outputTokens: partial.outputTokens ?? 0,
    cachedInputTokens: partial.cachedInputTokens ?? 0,
    reasoningTokens: partial.reasoningTokens ?? 0,
  }
}
