/**
 * Anthropic Messages codec。
 *
 * 在桥里只用上游侧的两半（上游说 Anthropic）：
 * - `encodeRequest`：IR → Anthropic 请求体
 * - `createStreamDecoder`：Anthropic SSE → IR 事件
 *
 * 为什么 Responses↔Anthropic 比 Responses↔Chat 好做：两边都是块中心的，
 * `content_block_start/delta/stop` 自带 index，和 Responses 的 output item 生命周期
 * 几乎逐个对应，不需要凭空合成块边界。
 *
 * Anthropic 侧的硬约束（都是发错就 400 的）：
 * 1. `max_tokens` 必填；
 * 2. user / assistant 必须严格交替；
 * 3. `tool_result` 块必须排在 user 消息最前面；
 * 4. 开 thinking 时不能同时设 temperature / top_p，且 assistant 消息里 thinking 块要在最前；
 * 5. thinking 块的 `signature` 下一轮必须原样回传，改一个字节就失效。
 */
import {
  type ProtocolCodec,
  type ResponseEncoder,
  type StreamDecoder,
  type UpstreamCapabilities,
} from '@shared/protocol/codec'
import type {
  IrBlock,
  IrEffort,
  IrMessage,
  IrOpaque,
  IrRequest,
  IrStreamEvent,
  IrToolChoice,
  IrToolResultContent,
  IrUsage,
} from '@shared/protocol/ir'

import { SseParser } from '../sse'

const PROTOCOL = 'anthropic.messages' as const

/** Anthropic 要求 anthropic-version 头，用官方稳定版本 */
const ANTHROPIC_VERSION = '2023-06-01'

// ---------------------------------------------------------------------------
// IR → Anthropic 请求
// ---------------------------------------------------------------------------

/**
 * effort → thinking budget。
 *
 * 返回 null 表示不开思考。梯度参考 cc-switch 的实测取值；上游若声明忽略 budget
 * （DeepSeek 就是），这里算出来的值只是走个形式，但仍要发 `thinking.type=enabled`
 * 才能让上游开思考。
 */
export function effortToThinkingBudget(effort: IrEffort | null): number | null {
  switch (effort) {
    case 'none':
      return null
    case 'minimal':
    case 'low':
      return 2048
    case 'medium':
      return 8192
    case 'high':
      return 16384
    case 'xhigh':
    case 'max':
      return 32768
    case null:
      // 请求里带了 reasoning 但没给 effort：按中档开
      return 8192
  }
}

function toolResultContent(content: IrToolResultContent[], caps: UpstreamCapabilities): unknown[] {
  const out: unknown[] = []
  for (const part of content) {
    if (part.kind === 'text') {
      if (part.text) out.push({ type: 'text', text: part.text })
      continue
    }
    if (!caps.supportsImages) {
      // 上游不收图片时降级成占位文字。发过去只会 400，丢了至少这轮还能继续。
      out.push({ type: 'text', text: '[图片已省略：上游不支持图片输入]' })
      continue
    }
    out.push({
      type: 'image',
      source: { type: 'base64', media_type: part.mediaType, data: part.dataBase64 },
    })
  }
  // Anthropic 不接受空的 tool_result content
  if (out.length === 0) out.push({ type: 'text', text: '' })
  return out
}

function encodeBlock(
  block: IrBlock,
  caps: UpstreamCapabilities,
  thinkingEnabled: boolean,
): unknown | null {
  switch (block.kind) {
    case 'text':
      return block.text ? { type: 'text', text: block.text } : null
    case 'image':
      if (!caps.supportsImages) {
        return { type: 'text', text: '[图片已省略：上游不支持图片输入]' }
      }
      return {
        type: 'image',
        source: { type: 'base64', media_type: block.mediaType, data: block.dataBase64 },
      }
    case 'reasoning': {
      // 没开思考就不回传 thinking 块——上游会因为「thinking 未启用却收到 thinking 块」报错
      if (!thinkingEnabled) return null
      const signature = restoreSignature(block.opaque)
      // 没有签名的 thinking 块回传会被官方 Anthropic 拒（签名是完整性校验）。
      // 降级成普通文本，保住上下文语义，不赌上游宽松。
      if (!signature) {
        return block.text ? { type: 'text', text: block.text } : null
      }
      return { type: 'thinking', thinking: block.text, signature }
    }
    case 'tool_call':
      return {
        type: 'tool_use',
        id: block.callId,
        name: block.name,
        input: parseToolInput(block.argumentsJson),
      }
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.callId,
        content: toolResultContent(block.content, caps),
        is_error: block.isError,
      }
  }
}

/** 上游要求 input 是对象。参数非法 JSON 时不能让整轮挂掉，退化成空对象。 */
function parseToolInput(argumentsJson: string): Record<string, unknown> {
  if (!argumentsJson.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(argumentsJson)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** 从 opaque 里取回 Anthropic 的 thinking signature */
function restoreSignature(opaque: IrOpaque | null): string | null {
  if (!opaque || opaque.protocol !== PROTOCOL) return null
  const payload = opaque.payload
  if (typeof payload === 'string') return payload
  if (typeof payload === 'object' && payload !== null) {
    const signature = (payload as Record<string, unknown>).signature
    if (typeof signature === 'string') return signature
  }
  return null
}

function encodeToolChoice(choice: IrToolChoice): unknown {
  switch (choice.mode) {
    case 'auto':
      return { type: 'auto' }
    case 'none':
      return { type: 'none' }
    case 'required':
      return { type: 'any' }
    case 'tool':
      return { type: 'tool', name: choice.name }
  }
}

/**
 * 把 IR 消息编成 Anthropic messages。
 *
 * 除了逐块翻译，还要满足两条 Anthropic 的排序约束：
 * tool_result 必须在 user 消息最前、thinking 必须在 assistant 消息最前。
 */
function encodeMessages(
  messages: IrMessage[],
  caps: UpstreamCapabilities,
  thinkingEnabled: boolean,
): unknown[] {
  const out: unknown[] = []

  for (const message of messages) {
    const encoded: unknown[] = []
    for (const block of message.blocks) {
      const value = encodeBlock(block, caps, thinkingEnabled)
      if (value !== null) encoded.push(value)
    }
    if (encoded.length === 0) continue

    const leadType = message.role === 'user' ? 'tool_result' : 'thinking'
    const lead = encoded.filter((v) => blockType(v) === leadType)
    const rest = encoded.filter((v) => blockType(v) !== leadType)

    out.push({ role: message.role, content: [...lead, ...rest] })
  }

  return out
}

function blockType(value: unknown): string {
  return typeof value === 'object' && value !== null
    ? String((value as Record<string, unknown>).type ?? '')
    : ''
}

/** 工具名超长时截断——保持确定性（同名总是截成同一个结果），否则多轮之间会对不上 */
function clampToolName(name: string, maxLength: number): string {
  if (name.length <= maxLength) return name
  return name.slice(0, maxLength)
}

export function encodeAnthropicRequest(ir: IrRequest, caps: UpstreamCapabilities): unknown {
  const budget = ir.reasoning.enabled ? effortToThinkingBudget(ir.reasoning.effort) : null
  const thinkingEnabled = budget !== null

  const maxTokens = ir.maxOutputTokens ?? caps.defaultMaxOutputTokens
  const body: Record<string, unknown> = {
    model: ir.model,
    // Anthropic 的 max_tokens 是必填项，且必须大于 thinking budget
    max_tokens: thinkingEnabled ? Math.max(maxTokens, budget + 1024) : maxTokens,
    messages: encodeMessages(ir.messages, caps, thinkingEnabled),
    stream: ir.stream,
  }

  if (ir.system) body.system = ir.system

  if (ir.tools.length > 0) {
    body.tools = ir.tools.map((tool) => ({
      name: clampToolName(tool.name, caps.toolNameMaxLength),
      description: tool.description,
      // Anthropic 要求 input_schema 顶层必须是 type:"object"
      input_schema:
        Object.keys(tool.parameters).length > 0
          ? { type: 'object', ...tool.parameters }
          : { type: 'object', properties: {} },
    }))
    body.tool_choice = encodeToolChoice(ir.toolChoice)
  }

  if (thinkingEnabled) {
    body.thinking = { type: 'enabled', budget_tokens: budget }
    // 开思考时 temperature / top_p 必须缺席，否则上游 400
    if (!caps.dropSamplingWhenThinking) {
      if (ir.temperature !== null) body.temperature = ir.temperature
      if (ir.topP !== null) body.top_p = ir.topP
    }
  } else {
    if (ir.temperature !== null) body.temperature = ir.temperature
    if (ir.topP !== null) body.top_p = ir.topP
  }

  return body
}

// ---------------------------------------------------------------------------
// Anthropic SSE → IR
// ---------------------------------------------------------------------------

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function decodeUsage(usage: Record<string, unknown> | null, previous: IrUsage): IrUsage {
  if (!usage) return previous
  return {
    // message_delta 的 usage 只带 output_tokens，input 要沿用 message_start 的
    inputTokens: usage.input_tokens !== undefined ? num(usage.input_tokens) : previous.inputTokens,
    outputTokens:
      usage.output_tokens !== undefined ? num(usage.output_tokens) : previous.outputTokens,
    cachedInputTokens:
      usage.cache_read_input_tokens !== undefined
        ? num(usage.cache_read_input_tokens)
        : previous.cachedInputTokens,
    reasoningTokens: previous.reasoningTokens,
  }
}

type IrEndEvent = Extract<IrStreamEvent, { type: 'end' }>

function mapStopReason(reason: string | null): IrEndEvent {
  switch (reason) {
    case 'max_tokens':
      return { type: 'end', stopReason: 'max_tokens' }
    case 'tool_use':
      return { type: 'end', stopReason: 'tool_use' }
    case 'stop_sequence':
      return { type: 'end', stopReason: 'stop_sequence' }
    case 'refusal':
      return { type: 'end', stopReason: 'refusal' }
    default:
      return { type: 'end', stopReason: 'completed' }
  }
}

class AnthropicStreamDecoder implements StreamDecoder {
  private readonly parser = new SseParser()
  private usage: IrUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  }
  private stopReason: string | null = null
  private ended = false
  /** 记住每个 index 开的是什么块——signature_delta 要靠它判断该不该转成 block_meta */
  private readonly kinds = new Map<number, 'text' | 'reasoning' | 'tool_call'>()

  push(chunk: Buffer): IrStreamEvent[] {
    return this.parser.push(chunk).flatMap((frame) => this.handle(frame.event, frame.data))
  }

  finish(): IrStreamEvent[] {
    const events = this.parser.finish().flatMap((frame) => this.handle(frame.event, frame.data))
    if (!this.ended) {
      // 上游断在半路：把用量交出去，终态由 bridge 的 finish() 决定，
      // 这里不擅自合成 end，避免和 encoder 的终态逻辑打架。
      events.push({ type: 'usage', usage: this.usage })
    }
    return events
  }

  private handle(eventName: string | undefined, data: string): IrStreamEvent[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return []
    }
    const event = record(parsed)
    if (!event) return []

    const type = eventName ?? (typeof event.type === 'string' ? event.type : '')
    const index = typeof event.index === 'number' ? event.index : 0

    switch (type) {
      case 'message_start': {
        const message = record(event.message)
        this.usage = decodeUsage(record(message?.usage), this.usage)
        return [
          {
            type: 'start',
            responseId: typeof message?.id === 'string' ? message.id : '',
            model: typeof message?.model === 'string' ? message.model : '',
          },
        ]
      }

      case 'content_block_start': {
        const block = record(event.content_block)
        const blockType = typeof block?.type === 'string' ? block.type : 'text'

        if (blockType === 'thinking' || blockType === 'redacted_thinking') {
          this.kinds.set(index, 'reasoning')
          const events: IrStreamEvent[] = [
            { type: 'block_start', index, block: { kind: 'reasoning' } },
          ]
          const initial = typeof block?.thinking === 'string' ? block.thinking : ''
          if (initial) events.push({ type: 'block_delta', index, delta: initial })
          return events
        }

        if (blockType === 'tool_use') {
          this.kinds.set(index, 'tool_call')
          const events: IrStreamEvent[] = [
            {
              type: 'block_start',
              index,
              block: {
                kind: 'tool_call',
                callId: typeof block?.id === 'string' ? block.id : '',
                name: typeof block?.name === 'string' ? block.name : '',
              },
            },
          ]
          // 有的网关不发 input_json_delta，直接在 start 里给完整 input
          const input = record(block?.input)
          if (input && Object.keys(input).length > 0) {
            events.push({ type: 'block_delta', index, delta: JSON.stringify(input) })
          }
          return events
        }

        this.kinds.set(index, 'text')
        const events: IrStreamEvent[] = [{ type: 'block_start', index, block: { kind: 'text' } }]
        const initial = typeof block?.text === 'string' ? block.text : ''
        if (initial) events.push({ type: 'block_delta', index, delta: initial })
        return events
      }

      case 'content_block_delta': {
        const delta = record(event.delta)
        const deltaType = typeof delta?.type === 'string' ? delta.type : ''

        if (deltaType === 'text_delta') {
          return [{ type: 'block_delta', index, delta: String(delta?.text ?? '') }]
        }
        if (deltaType === 'thinking_delta') {
          return [{ type: 'block_delta', index, delta: String(delta?.thinking ?? '') }]
        }
        if (deltaType === 'input_json_delta') {
          return [{ type: 'block_delta', index, delta: String(delta?.partial_json ?? '') }]
        }
        if (deltaType === 'signature_delta') {
          const signature = typeof delta?.signature === 'string' ? delta.signature : ''
          if (!signature) return []
          // 签名不是可见内容，走 block_meta：encoder 把它塞进 encrypted_content 带回 codex，
          // 下一轮再解出来还给上游，思考链才能续上。
          return [
            {
              type: 'block_meta',
              index,
              opaque: { protocol: PROTOCOL, payload: { signature } },
            },
          ]
        }
        return []
      }

      case 'content_block_stop':
        this.kinds.delete(index)
        return [{ type: 'block_end', index }]

      case 'message_delta': {
        const delta = record(event.delta)
        const reason = typeof delta?.stop_reason === 'string' ? delta.stop_reason : null
        if (reason) this.stopReason = reason
        this.usage = decodeUsage(record(event.usage), this.usage)
        return []
      }

      case 'message_stop': {
        this.ended = true
        return [{ type: 'usage', usage: this.usage }, mapStopReason(this.stopReason)]
      }

      case 'error': {
        this.ended = true
        const error = record(event.error)
        return [
          {
            type: 'error',
            message:
              (typeof error?.message === 'string' ? error.message : null) ?? '上游返回错误事件',
            kind: (typeof error?.type === 'string' ? error.type : null) ?? 'upstream_error',
          },
        ]
      }

      default:
        // ping 等心跳事件
        return []
    }
  }
}

/** 非流式响应归一成同一组事件——让 bridge 的下游逻辑不用区分流式/非流式 */
function decodeAnthropicResponse(body: unknown): IrStreamEvent[] {
  const root = record(body)
  if (!root) return [{ type: 'error', message: '上游返回了非 JSON 对象', kind: 'bad_response' }]

  const error = record(root.error)
  if (error) {
    return [
      {
        type: 'error',
        message: typeof error.message === 'string' ? error.message : '上游返回错误',
        kind: typeof error.type === 'string' ? error.type : 'upstream_error',
      },
    ]
  }

  const events: IrStreamEvent[] = [
    {
      type: 'start',
      responseId: typeof root.id === 'string' ? root.id : '',
      model: typeof root.model === 'string' ? root.model : '',
    },
  ]

  const content = Array.isArray(root.content) ? root.content : []
  content.forEach((raw, index) => {
    const block = record(raw)
    const blockType = typeof block?.type === 'string' ? block.type : ''

    if (blockType === 'thinking') {
      events.push({ type: 'block_start', index, block: { kind: 'reasoning' } })
      events.push({ type: 'block_delta', index, delta: String(block?.thinking ?? '') })
      if (typeof block?.signature === 'string' && block.signature) {
        events.push({
          type: 'block_meta',
          index,
          opaque: { protocol: PROTOCOL, payload: { signature: block.signature } },
        })
      }
    } else if (blockType === 'tool_use') {
      events.push({
        type: 'block_start',
        index,
        block: {
          kind: 'tool_call',
          callId: typeof block?.id === 'string' ? block.id : '',
          name: typeof block?.name === 'string' ? block.name : '',
        },
      })
      events.push({ type: 'block_delta', index, delta: JSON.stringify(block?.input ?? {}) })
    } else {
      events.push({ type: 'block_start', index, block: { kind: 'text' } })
      events.push({ type: 'block_delta', index, delta: String(block?.text ?? '') })
    }
    events.push({ type: 'block_end', index })
  })

  const usage = record(root.usage)
  if (usage) {
    events.push({
      type: 'usage',
      usage: decodeUsage(usage, {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
      }),
    })
  }
  events.push(mapStopReason(typeof root.stop_reason === 'string' ? root.stop_reason : null))
  return events
}

/** Anthropic 作为客户端协议时才需要（claude 后端方向），桥当前用不到 */
function unsupportedEncoder(): ResponseEncoder {
  throw new Error('anthropic.messages 目前只实现了上游侧，不能作为桥的客户端协议')
}

export const anthropicMessagesCodec: ProtocolCodec = {
  id: PROTOCOL,
  decodeRequest: () => {
    throw new Error('anthropic.messages 目前只实现了上游侧，不能作为桥的客户端协议')
  },
  createResponseEncoder: unsupportedEncoder,
  encodeRequest: encodeAnthropicRequest,
  createStreamDecoder: () => new AnthropicStreamDecoder(),
  decodeResponse: decodeAnthropicResponse,
  upstreamPath: () => '/v1/messages',
  authHeaders: (apiKey) => ({
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  }),
}
