/**
 * OpenAI Responses codec。
 *
 * 在桥里它只用客户端侧的两半（codex 说 Responses）：
 * - `decodeRequest`：codex 的 Responses 请求 → IR
 * - `createResponseEncoder`：IR 事件流 → Responses SSE 字节
 *
 * 上游侧的两半（encodeRequest / createStreamDecoder）也实现了，这样将来
 * 「claude 后端 → Responses 上游」能直接复用，不用再写一遍。
 *
 * 转换是**白名单重建**而不是原地改：从空对象起手逐个 copy 已知字段。
 * `store` / `include` / `previous_response_id` / `text` 这些上游不认识的字段
 * 一律丢弃——比"删掉几个已知不兼容字段"安全得多。
 */
import { randomUUID } from 'node:crypto'

import {
  BridgeRequestError,
  type ProtocolCodec,
  type ResponseEncoder,
  type StreamDecoder,
  type UpstreamCapabilities,
} from '@shared/protocol/codec'
import {
  emptyUsage,
  mergeAdjacentMessages,
  type IrBlock,
  type IrEffort,
  type IrMessage,
  type IrOpaque,
  type IrRequest,
  type IrStopReason,
  type IrStreamBlockStart,
  type IrStreamEvent,
  type IrTool,
  type IrToolChoice,
  type IrToolResultContent,
  type IrUsage,
} from '@shared/protocol/ir'

import { encodeSseFrame, SseParser } from '../sse'

const PROTOCOL = 'openai.responses' as const

// ---------------------------------------------------------------------------
// 请求：Responses → IR
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** `instructions` 可能是字符串，也可能是 [{text}] 形态 */
function instructionText(value: unknown): string {
  const text = asString(value)
  if (text !== null) return text
  if (Array.isArray(value)) {
    return value
      .map((part) => asString(part) ?? asString(asRecord(part)?.text) ?? '')
      .filter((s) => s.length > 0)
      .join('\n\n')
  }
  return ''
}

/** Responses 的 content 数组 → IR 块（只取文本和图片，其它形态忽略） */
function contentPartsToBlocks(content: unknown): IrBlock[] {
  if (typeof content === 'string') {
    return content ? [{ kind: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []

  const blocks: IrBlock[] = []
  for (const raw of content) {
    const part = asRecord(raw)
    if (!part) continue
    const type = asString(part.type)
    if (
      type === 'input_text' ||
      type === 'output_text' ||
      type === 'text' ||
      type === 'summary_text'
    ) {
      const text = asString(part.text) ?? ''
      if (text) blocks.push({ kind: 'text', text })
      continue
    }
    if (type === 'input_image' || type === 'image') {
      const image = parseImagePart(part)
      if (image) blocks.push(image)
      continue
    }
    // input_file / input_audio 等暂不支持，降级成一句说明而不是静默丢弃
    if (type === 'input_file' || type === 'input_audio') {
      const name = asString(part.filename) ?? type
      blocks.push({ kind: 'text', text: `[未支持的附件：${name}]` })
    }
  }
  return blocks
}

/** `image_url` 可能是 data URI，也可能是 http 链接（后者我们无法内联，降级成文字） */
function parseImagePart(part: Record<string, unknown>): IrBlock | null {
  const url = asString(part.image_url) ?? asString(asRecord(part.image_url)?.url)
  if (!url) return null
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  if (!match) return { kind: 'text', text: `[图片链接：${url}]` }
  return { kind: 'image', mediaType: match[1]!, dataBase64: match[2]! }
}

/** reasoning item 的可见文本在 summary[]（有时也在 content[]） */
function reasoningItemText(item: Record<string, unknown>): string {
  const parts: string[] = []
  for (const key of ['summary', 'content']) {
    const value = item[key]
    if (!Array.isArray(value)) continue
    for (const raw of value) {
      const entry = asRecord(raw)
      const text = asString(entry?.text) ?? asString(raw)
      if (text) parts.push(text)
    }
  }
  return parts.join('')
}

/** function_call_output 的 output 可能是字符串、结构化值、或多模态块数组 */
function toolOutputToContent(output: unknown): IrToolResultContent[] {
  if (output === undefined || output === null) return []
  if (typeof output === 'string') {
    return output ? [{ kind: 'text', text: output }] : []
  }
  if (Array.isArray(output)) {
    const blocks = contentPartsToBlocks(output).filter(
      (block): block is IrToolResultContent => block.kind === 'text' || block.kind === 'image',
    )
    if (blocks.length > 0) return blocks
  }
  const record = asRecord(output)
  // codex 常见形态：{ output: "...", success: true }
  const inner = asString(record?.output)
  if (inner !== null) return inner ? [{ kind: 'text', text: inner }] : []
  return [{ kind: 'text', text: JSON.stringify(output) }]
}

function toolOutputIsError(item: Record<string, unknown>): boolean {
  const record = asRecord(item.output)
  if (record && typeof record.success === 'boolean') return !record.success
  return item.status === 'failed' || item.error !== undefined
}

function decodeTools(value: unknown): IrTool[] {
  if (!Array.isArray(value)) return []
  const tools: IrTool[] = []
  for (const raw of value) {
    const tool = asRecord(raw)
    if (!tool) continue
    const type = asString(tool.type)
    // 只认标准 function 工具。codex 的 custom / namespace / tool_search 形态在
    // Anthropic 上游没有对应物，且 codex 只在官方后端才发，这里显式跳过而不是
    // 半吊子映射——真遇到了应该在这里补一个降级分支，而不是让上游 400。
    if (type !== null && type !== 'function') continue
    const name = asString(tool.name) ?? asString(asRecord(tool.function)?.name)
    if (!name) continue
    const source = asRecord(tool.function) ?? tool
    const parameters = asRecord(source.parameters) ?? {}
    tools.push({
      name,
      description: asString(source.description) ?? '',
      parameters,
    })
  }
  return tools
}

function decodeToolChoice(value: unknown): IrToolChoice {
  if (value === undefined || value === null) return { mode: 'auto' }
  const text = asString(value)
  if (text === 'auto') return { mode: 'auto' }
  if (text === 'none') return { mode: 'none' }
  if (text === 'required' || text === 'any') return { mode: 'required' }
  const record = asRecord(value)
  if (record) {
    const name = asString(record.name) ?? asString(asRecord(record.function)?.name)
    if (name) return { mode: 'tool', name }
    const type = asString(record.type)
    if (type === 'any' || type === 'required') return { mode: 'required' }
    if (type === 'none') return { mode: 'none' }
  }
  return { mode: 'auto' }
}

const EFFORTS: readonly IrEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function decodeReasoning(value: unknown): { enabled: boolean; effort: IrEffort | null } {
  if (value === undefined) return { enabled: false, effort: null }
  if (value === null) return { enabled: false, effort: null }
  const record = asRecord(value)
  const raw = asString(record?.effort)?.trim().toLowerCase() ?? null
  if (raw === null) return { enabled: true, effort: null }
  if (raw === 'none' || raw === 'off' || raw === 'disabled')
    return { enabled: false, effort: 'none' }
  const effort = EFFORTS.find((e) => e === raw) ?? null
  return { enabled: true, effort }
}

export function decodeResponsesRequest(body: unknown): IrRequest {
  const root = asRecord(body)
  if (!root) throw new BridgeRequestError('请求体必须是 JSON 对象')

  const model = asString(root.model)
  if (!model) throw new BridgeRequestError('请求缺少 model 字段')

  const messages: IrMessage[] = []
  const push = (role: IrMessage['role'], blocks: IrBlock[]): void => {
    if (blocks.length > 0) messages.push({ role, blocks })
  }

  const input = root.input
  if (typeof input === 'string') {
    push('user', [{ kind: 'text', text: input }])
  } else if (Array.isArray(input)) {
    for (const raw of input) {
      const item = asRecord(raw)
      if (!item) continue
      const type = asString(item.type)

      switch (type) {
        case 'function_call': {
          const callId = asString(item.call_id) ?? asString(item.id)
          if (!callId) break
          push('assistant', [
            {
              kind: 'tool_call',
              callId,
              name: asString(item.name) ?? '',
              argumentsJson: asString(item.arguments) ?? '{}',
              opaque: null,
            },
          ])
          break
        }
        case 'function_call_output': {
          const callId = asString(item.call_id)
          if (!callId) break
          push('user', [
            {
              kind: 'tool_result',
              callId,
              content: toolOutputToContent(item.output),
              isError: toolOutputIsError(item),
            },
          ])
          break
        }
        case 'reasoning': {
          // encrypted_content 优先按「我们上一轮塞进去的封装」解：解出来的是上游协议的
          // 原生载荷（如 Anthropic 的 thinking signature），能直接还给上游续上思考链。
          // 解不出来说明是上游真的加密内容，整个 item 原样留着走 Responses 通路。
          const restored = decodeOpaque(item.encrypted_content)
          push('assistant', [
            {
              kind: 'reasoning',
              text: reasoningItemText(item),
              opaque: restored ?? { protocol: PROTOCOL, payload: item },
            },
          ])
          break
        }
        case 'input_text':
        case 'input_image':
        case 'input_file':
        case 'input_audio': {
          const role = asString(item.role) === 'assistant' ? 'assistant' : 'user'
          push(role, contentPartsToBlocks([item]))
          break
        }
        default: {
          // 'message' 和没有 type 的裸消息
          if (item.role !== undefined || item.content !== undefined) {
            const role = asString(item.role) === 'assistant' ? 'assistant' : 'user'
            push(role, contentPartsToBlocks(item.content))
          }
          break
        }
      }
    }
  }

  const temperature = typeof root.temperature === 'number' ? root.temperature : null
  const topP = typeof root.top_p === 'number' ? root.top_p : null
  const maxOutputTokens =
    typeof root.max_output_tokens === 'number'
      ? root.max_output_tokens
      : typeof root.max_tokens === 'number'
        ? root.max_tokens
        : null

  return {
    model,
    system: instructionText(root.instructions),
    messages: mergeAdjacentMessages(messages),
    tools: decodeTools(root.tools),
    toolChoice: decodeToolChoice(root.tool_choice),
    maxOutputTokens,
    temperature,
    topP,
    reasoning: decodeReasoning(root.reasoning),
    stream: root.stream !== false,
    vendor: { protocol: PROTOCOL, body },
  }
}

// ---------------------------------------------------------------------------
// 响应：IR 事件 → Responses SSE
// ---------------------------------------------------------------------------

type EncoderBlockKind = 'text' | 'reasoning' | 'tool_call'

interface EncoderBlock {
  kind: EncoderBlockKind
  outputIndex: number
  itemId: string
  /** 累积的文本 / 工具参数 */
  buffer: string
  callId: string
  name: string
  opaque: IrOpaque | null
  closed: boolean
}

function usageToResponses(usage: IrUsage): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens,
    input_tokens_details: { cached_tokens: usage.cachedInputTokens },
    output_tokens: usage.outputTokens,
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
    total_tokens: usage.inputTokens + usage.outputTokens,
  }
}

function stopReasonToStatus(reason: IrStopReason): string {
  return reason === 'max_tokens' ? 'incomplete' : 'completed'
}

/**
 * Responses SSE 编码器。
 *
 * 硬性保证：`response.created` 恰好发一次、每个 output item 的 added/done 严格配对、
 * 终止事件（completed 或 failed）恰好发一次。上游怎么断都不破坏这三条。
 */
class ResponsesEncoder implements ResponseEncoder {
  private readonly responseId = `resp_${randomUUID().replace(/-/g, '')}`
  private readonly createdAt = Math.floor(Date.now() / 1000)
  private model: string
  private started = false
  private terminated = false
  private nextOutputIndex = 0
  private readonly blocks = new Map<number, EncoderBlock>()
  private readonly completedItems: Array<{ index: number; item: unknown }> = []
  private usage: IrUsage = emptyUsage()
  private stopReason: IrStopReason | null = null

  constructor(
    model: string,
    private readonly caps: UpstreamCapabilities,
  ) {
    this.model = model
  }

  push(event: IrStreamEvent): Buffer[] {
    if (this.terminated) return []

    switch (event.type) {
      case 'start':
        if (event.model) this.model = event.model
        return this.ensureStarted()
      case 'block_start':
        return [...this.ensureStarted(), ...this.openBlock(event.index, event.block)]
      case 'block_delta':
        return this.pushDelta(event.index, event.delta)
      case 'block_meta': {
        const block = this.blocks.get(event.index)
        if (block) block.opaque = event.opaque
        return []
      }
      case 'block_end':
        return this.closeBlock(event.index)
      case 'usage':
        this.usage = event.usage
        return []
      case 'end':
        this.stopReason = event.stopReason
        return this.terminate(
          event.stopReason === 'error' ? 'error' : 'completed',
          undefined,
          event.stopReason,
        )
      case 'error':
        return this.terminate('error', event.message)
    }
  }

  finish(reason: 'completed' | 'truncated' | 'error', message?: string): Buffer[] {
    if (this.terminated) return []
    if (reason === 'completed') return this.terminate('completed', undefined, 'completed')
    if (reason === 'truncated') {
      // 上游断在半路但已经吐出过内容：按 max_tokens 收尾，让 codex 保住已有输出，
      // 好过整轮报错丢干净。
      if (this.completedItems.length > 0 || this.blocks.size > 0) {
        return this.terminate('completed', undefined, 'max_tokens')
      }
      return this.terminate('error', message ?? '上游在发出任何内容前就断开了流')
    }
    return this.terminate('error', message ?? '上游流出错')
  }

  private ensureStarted(): Buffer[] {
    if (this.started) return []
    this.started = true
    return [
      encodeSseFrame('response.created', {
        type: 'response.created',
        response: this.responseObject('in_progress'),
      }),
      encodeSseFrame('response.in_progress', {
        type: 'response.in_progress',
        response: this.responseObject('in_progress'),
      }),
    ]
  }

  private openBlock(index: number, start: IrStreamBlockStart): Buffer[] {
    if (this.blocks.has(index)) return []

    const outputIndex = this.nextOutputIndex++
    const prefix = start.kind === 'text' ? 'msg' : start.kind === 'reasoning' ? 'rs' : 'fc'
    const block: EncoderBlock = {
      kind: start.kind,
      outputIndex,
      itemId: `${prefix}_${randomUUID().replace(/-/g, '')}`,
      buffer: '',
      callId: start.kind === 'tool_call' ? start.callId : '',
      name: start.kind === 'tool_call' ? start.name : '',
      opaque: null,
      closed: false,
    }
    this.blocks.set(index, block)

    const added = encodeSseFrame('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: this.itemValue(block, 'in_progress'),
    })

    if (block.kind === 'text') {
      return [
        added,
        encodeSseFrame('response.content_part.added', {
          type: 'response.content_part.added',
          item_id: block.itemId,
          output_index: outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        }),
      ]
    }
    if (block.kind === 'reasoning') {
      return [
        added,
        encodeSseFrame('response.reasoning_summary_part.added', {
          type: 'response.reasoning_summary_part.added',
          item_id: block.itemId,
          output_index: outputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: '' },
        }),
      ]
    }
    return [added]
  }

  private pushDelta(index: number, delta: string): Buffer[] {
    const block = this.blocks.get(index)
    if (!block || block.closed || !delta) return []
    block.buffer += delta

    switch (block.kind) {
      case 'text':
        return [
          encodeSseFrame('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: block.itemId,
            output_index: block.outputIndex,
            content_index: 0,
            delta,
          }),
        ]
      case 'reasoning':
        return [
          encodeSseFrame('response.reasoning_summary_text.delta', {
            type: 'response.reasoning_summary_text.delta',
            item_id: block.itemId,
            output_index: block.outputIndex,
            summary_index: 0,
            delta,
          }),
        ]
      case 'tool_call':
        return [
          encodeSseFrame('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: block.itemId,
            output_index: block.outputIndex,
            delta,
          }),
        ]
    }
  }

  private closeBlock(index: number): Buffer[] {
    const block = this.blocks.get(index)
    if (!block || block.closed) return []
    block.closed = true

    const frames: Buffer[] = []
    const item = this.itemValue(block, 'completed')

    if (block.kind === 'text') {
      frames.push(
        encodeSseFrame('response.output_text.done', {
          type: 'response.output_text.done',
          item_id: block.itemId,
          output_index: block.outputIndex,
          content_index: 0,
          text: block.buffer,
        }),
        encodeSseFrame('response.content_part.done', {
          type: 'response.content_part.done',
          item_id: block.itemId,
          output_index: block.outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: block.buffer, annotations: [] },
        }),
      )
    } else if (block.kind === 'reasoning') {
      frames.push(
        encodeSseFrame('response.reasoning_summary_text.done', {
          type: 'response.reasoning_summary_text.done',
          item_id: block.itemId,
          output_index: block.outputIndex,
          summary_index: 0,
          text: block.buffer,
        }),
        encodeSseFrame('response.reasoning_summary_part.done', {
          type: 'response.reasoning_summary_part.done',
          item_id: block.itemId,
          output_index: block.outputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: block.buffer },
        }),
      )
    } else {
      frames.push(
        encodeSseFrame('response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done',
          item_id: block.itemId,
          output_index: block.outputIndex,
          arguments: block.buffer,
        }),
      )
    }

    frames.push(
      encodeSseFrame('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: block.outputIndex,
        item,
      }),
    )
    this.completedItems.push({ index: block.outputIndex, item })
    return frames
  }

  private terminate(
    kind: 'completed' | 'error',
    message?: string,
    stopReason?: IrStopReason,
  ): Buffer[] {
    const frames = this.ensureStarted()
    // 还开着的块先按序收尾，保证 added/done 配对
    for (const index of [...this.blocks.keys()].sort((a, b) => a - b)) {
      frames.push(...this.closeBlock(index))
    }
    this.terminated = true

    if (kind === 'error') {
      const response = this.responseObject('failed')
      response.error = { code: 'upstream_error', message: message ?? '上游错误' }
      frames.push(encodeSseFrame('response.failed', { type: 'response.failed', response }))
      return frames
    }

    const reason = stopReason ?? this.stopReason ?? 'completed'
    const response = this.responseObject(stopReasonToStatus(reason))
    if (reason === 'max_tokens') {
      response.incomplete_details = { reason: 'max_output_tokens' }
    }
    frames.push(encodeSseFrame('response.completed', { type: 'response.completed', response }))
    return frames
  }

  private itemValue(block: EncoderBlock, status: 'in_progress' | 'completed'): unknown {
    if (block.kind === 'text') {
      return {
        id: block.itemId,
        type: 'message',
        status,
        role: 'assistant',
        content:
          status === 'completed'
            ? [{ type: 'output_text', text: block.buffer, annotations: [] }]
            : [],
      }
    }
    if (block.kind === 'reasoning') {
      const item: Record<string, unknown> = {
        id: block.itemId,
        type: 'reasoning',
        summary:
          status === 'completed' && block.buffer
            ? [{ type: 'summary_text', text: block.buffer }]
            : [],
      }
      // 上游的思考签名原样带回：codex 下一轮会把整个 item 回传给我们，
      // 我们再解出来还给上游，思考链才不会断。
      //
      // 默认**不带**：codex 会把它写进 rollout 永久保存，关桥后这段历史直接发给
      // ChatGPT，它验签失败并拒绝整轮（`encrypted content ... could not be verified`），
      // 会话彻底作废。只有真需要签名的上游（官方 Anthropic 的 tool use 多轮）才值得
      // 付这个代价——见 UpstreamCapabilities.preserveThinkingSignature。
      if (block.opaque && this.caps.preserveThinkingSignature) {
        item.encrypted_content = encodeOpaque(block.opaque)
      }
      return item
    }
    return {
      id: block.itemId,
      type: 'function_call',
      status,
      call_id: block.callId,
      name: block.name,
      arguments: status === 'completed' ? block.buffer : '',
    }
  }

  private responseObject(status: string): Record<string, unknown> {
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      status,
      model: this.model,
      output: this.completedItems
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((entry) => entry.item),
      usage: usageToResponses(this.usage),
      error: null,
      incomplete_details: null,
      instructions: null,
      max_output_tokens: null,
      parallel_tool_calls: true,
      previous_response_id: null,
      reasoning: { effort: null, summary: null },
      store: false,
      temperature: null,
      text: { format: { type: 'text' } },
      tool_choice: 'auto',
      tools: [],
      top_p: null,
      truncation: 'disabled',
      metadata: {},
    }
  }
}

/**
 * 不透明载荷的封装格式。
 *
 * 用带前缀的 base64 而不是裸 JSON：codex 会把 `encrypted_content` 当黑盒原样回传，
 * 前缀让我们在下一轮能确认「这是我们自己塞进去的」，而不是把上游真的加密内容
 * 误当成我们的封装去解。
 */
const OPAQUE_PREFIX = 'catmax-bridge-v1:'

export function encodeOpaque(opaque: IrOpaque): string {
  return OPAQUE_PREFIX + Buffer.from(JSON.stringify(opaque), 'utf-8').toString('base64url')
}

export function decodeOpaque(value: unknown): IrOpaque | null {
  const text = asString(value)
  if (!text || !text.startsWith(OPAQUE_PREFIX)) return null
  try {
    const json = Buffer.from(text.slice(OPAQUE_PREFIX.length), 'base64url').toString('utf-8')
    const parsed = JSON.parse(json) as IrOpaque
    return parsed && typeof parsed.protocol === 'string' ? parsed : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 上游侧（供将来「客户端说别的协议 → Responses 上游」复用）
// ---------------------------------------------------------------------------

function encodeResponsesRequest(ir: IrRequest, _caps: UpstreamCapabilities): unknown {
  const input: unknown[] = []
  for (const message of ir.messages) {
    for (const block of message.blocks) {
      switch (block.kind) {
        case 'text':
          input.push({
            type: 'message',
            role: message.role,
            content: [
              {
                type: message.role === 'assistant' ? 'output_text' : 'input_text',
                text: block.text,
              },
            ],
          })
          break
        case 'image':
          input.push({
            type: 'message',
            role: message.role,
            content: [
              {
                type: 'input_image',
                image_url: `data:${block.mediaType};base64,${block.dataBase64}`,
              },
            ],
          })
          break
        case 'reasoning': {
          const restored = block.opaque?.protocol === PROTOCOL ? block.opaque.payload : null
          input.push(
            restored ?? {
              type: 'reasoning',
              summary: block.text ? [{ type: 'summary_text', text: block.text }] : [],
            },
          )
          break
        }
        case 'tool_call':
          input.push({
            type: 'function_call',
            call_id: block.callId,
            name: block.name,
            arguments: block.argumentsJson,
          })
          break
        case 'tool_result':
          input.push({
            type: 'function_call_output',
            call_id: block.callId,
            output: block.content
              .map((part) => (part.kind === 'text' ? part.text : '[图片]'))
              .join('\n'),
          })
          break
      }
    }
  }

  const body: Record<string, unknown> = {
    model: ir.model,
    input,
    stream: ir.stream,
  }
  if (ir.system) body.instructions = ir.system
  if (ir.tools.length > 0) {
    body.tools = ir.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
    body.tool_choice = encodeToolChoice(ir.toolChoice)
  }
  if (ir.maxOutputTokens !== null) body.max_output_tokens = ir.maxOutputTokens
  if (ir.temperature !== null) body.temperature = ir.temperature
  if (ir.topP !== null) body.top_p = ir.topP
  if (ir.reasoning.enabled && ir.reasoning.effort) {
    body.reasoning = { effort: ir.reasoning.effort }
  }
  return body
}

function encodeToolChoice(choice: IrToolChoice): unknown {
  switch (choice.mode) {
    case 'auto':
      return 'auto'
    case 'none':
      return 'none'
    case 'required':
      return 'required'
    case 'tool':
      return { type: 'function', name: choice.name }
  }
}

/** Responses SSE → IR。用于「Responses 作为上游」的方向。 */
class ResponsesStreamDecoder implements StreamDecoder {
  private readonly parser = new SseParser()
  /** Responses 的 output_index 直接当 IR 的块 index 用 */
  private readonly started = new Set<number>()

  push(chunk: Buffer): IrStreamEvent[] {
    return this.parser.push(chunk).flatMap((frame) => this.handle(frame.data))
  }

  finish(): IrStreamEvent[] {
    return this.parser.finish().flatMap((frame) => this.handle(frame.data))
  }

  private handle(data: string): IrStreamEvent[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return []
    }
    const event = asRecord(parsed)
    if (!event) return []
    const type = asString(event.type) ?? ''
    const outputIndex = typeof event.output_index === 'number' ? event.output_index : 0

    switch (type) {
      case 'response.created': {
        const response = asRecord(event.response)
        return [
          {
            type: 'start',
            responseId: asString(response?.id) ?? '',
            model: asString(response?.model) ?? '',
          },
        ]
      }
      case 'response.output_item.added': {
        const item = asRecord(event.item)
        const itemType = asString(item?.type)
        this.started.add(outputIndex)
        if (itemType === 'reasoning') {
          return [{ type: 'block_start', index: outputIndex, block: { kind: 'reasoning' } }]
        }
        if (itemType === 'function_call') {
          return [
            {
              type: 'block_start',
              index: outputIndex,
              block: {
                kind: 'tool_call',
                callId: asString(item?.call_id) ?? '',
                name: asString(item?.name) ?? '',
              },
            },
          ]
        }
        return [{ type: 'block_start', index: outputIndex, block: { kind: 'text' } }]
      }
      case 'response.output_text.delta':
      case 'response.reasoning_summary_text.delta':
      case 'response.function_call_arguments.delta':
        return [{ type: 'block_delta', index: outputIndex, delta: asString(event.delta) ?? '' }]
      case 'response.output_item.done':
        this.started.delete(outputIndex)
        return [{ type: 'block_end', index: outputIndex }]
      case 'response.completed': {
        const response = asRecord(event.response)
        const events: IrStreamEvent[] = []
        const usage = decodeResponsesUsage(asRecord(response?.usage))
        if (usage) events.push({ type: 'usage', usage })
        events.push({
          type: 'end',
          stopReason: asString(response?.status) === 'incomplete' ? 'max_tokens' : 'completed',
        })
        return events
      }
      case 'response.failed': {
        const response = asRecord(event.response)
        const error = asRecord(response?.error)
        return [
          {
            type: 'error',
            message: asString(error?.message) ?? '上游返回 response.failed',
            kind: asString(error?.code) ?? 'upstream_error',
          },
        ]
      }
      default:
        return []
    }
  }
}

function decodeResponsesUsage(usage: Record<string, unknown> | null): IrUsage | null {
  if (!usage) return null
  const num = (value: unknown): number => (typeof value === 'number' ? value : 0)
  return {
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cachedInputTokens: num(asRecord(usage.input_tokens_details)?.cached_tokens),
    reasoningTokens: num(asRecord(usage.output_tokens_details)?.reasoning_tokens),
  }
}

export const openaiResponsesCodec: ProtocolCodec = {
  id: PROTOCOL,
  decodeRequest: decodeResponsesRequest,
  createResponseEncoder: (ctx) => new ResponsesEncoder(ctx.model, ctx.capabilities),
  encodeRequest: encodeResponsesRequest,
  createStreamDecoder: () => new ResponsesStreamDecoder(),
  decodeResponse: () => [],
  upstreamPath: () => '/v1/responses',
  authHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
}
