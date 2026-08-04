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
import type { BridgeAuthScheme } from './bridge-config'
import type { IrRequest, IrStreamEvent, IrUsage, ProtocolId } from './ir'

/** 上游的能力/怪癖声明。是数据不是分支——加一家上游只加一条配置。 */
export interface UpstreamCapabilities {
  /** 不支持图片时，图片块降级成文字占位而不是原样发过去触发 400 */
  supportsImages: boolean
  /**
   * 这里刻意**没有** respectsThinkingBudget。
   *
   * 曾经有过这个开关，但它无法对应任何真实行为：`thinking.type=enabled` 时
   * Anthropic 协议要求 `budget_tokens` 必填，所以无论上游是否理会这个值，桥都得发；
   * 而上游是否理会它是上游的事，桥这边没有可分支的动作。真正不发 thinking 的情况
   * 只有 effort='none'，那是 effortToThinkingBudget 无条件处理的，跟上游能力无关。
   * 上游忽略 budget（DeepSeek 就是）属于要在 UI 里**告知**用户的事实（见
   * bridge-config.ts 的预设文案），不是要在编码时分支的能力。
   */
  /** 开启思考时是否必须去掉 temperature / top_p（Anthropic 系的硬约束） */
  dropSamplingWhenThinking: boolean
  /** 上游要求 max_tokens 必填时的兜底值 */
  defaultMaxOutputTokens: number
  /** 工具名长度上限，超了要截断并建立映射 */
  toolNameMaxLength: number
  /**
   * 是否把上游的思考签名回传给客户端（Responses 的 `encrypted_content`）。
   *
   * 关掉是默认：codex 会把这个字段**永久写进 rollout**，而里面是桥自己的封装，
   * 只有桥认得。关桥后同一段历史被直接发给 ChatGPT，它验签失败并拒绝整轮——
   * 那个会话从此发不出消息。详见 settings-schema.ts 里的完整说明。
   */
  preserveThinkingSignature: boolean
}

export const DEFAULT_UPSTREAM_CAPABILITIES: UpstreamCapabilities = {
  supportsImages: true,
  dropSamplingWhenThinking: true,
  defaultMaxOutputTokens: 8192,
  toolNameMaxLength: 64,
  preserveThinkingSignature: false,
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
  createResponseEncoder(ctx: { model: string; capabilities: UpstreamCapabilities }): ResponseEncoder

  // ── 上游侧 ──
  encodeRequest(ir: IrRequest, caps: UpstreamCapabilities): unknown
  createStreamDecoder(): StreamDecoder
  /** 上游走非流式时，把整个响应体归一成同一组事件 */
  decodeResponse(body: unknown): IrStreamEvent[]

  /** 相对 base_url 的请求路径，如 '/v1/messages' */
  upstreamPath(): string
  /**
   * 凭证注入方式，各协议不同。scheme 让同一协议的 codec 按上游要求切换
   * 认证头风格（x-api-key vs Authorization: Bearer）。
   */
  authHeaders(apiKey: string, scheme: BridgeAuthScheme): Record<string, string>
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
