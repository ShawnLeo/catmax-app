/**
 * Protocol Bridge IR: 协议无关的中间表示。
 *
 * 为什么要 IR 而不是两两直转：catmax 的真实矩阵是「N 个客户端协议 × M 个上游协议」
 * （codex 说 Responses、claude 说 Anthropic，上游还可能是 Chat Completions）。
 * 两两直转每加一个协议要写 2N 个模块，IR 只要写 1 个 codec 就能和所有已有协议互通。
 *
 * IR 按「块」建模而不是按「消息」建模——Responses 的 item 和 Anthropic 的 content block
 * 都是块中心的，这是它们能高保真互转的根本原因。Chat Completions 的消息中心模型
 * 是这三者里的特例，由它自己的 codec 负责摊平/合成，不污染 IR。
 *
 * 保真度兜底靠两条：
 * 1. `IrRequest.vendor` 逐字保留原始请求体——同协议直通时不走重建，保真 100%；
 * 2. `IrOpaque` 让目标协议表达不了的东西（thinking signature、encrypted_content、
 *    item id）原样封装带着走，回到源协议时解封还原。
 *
 * 这里只放类型和纯函数，不 import 任何 node/electron —— shared 层的规矩。
 */

/** 已知协议 id。加新协议先在这里加字面量。 */
export type ProtocolId = 'openai.responses' | 'anthropic.messages' | 'openai.chat'

/** 思考强度。和 shared/backend/types.ts 的 EffortLevel 保持同一组字面量。 */
export type IrEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * 目标协议表达不了、但必须原样带回源协议的载荷。
 *
 * 典型用途：Anthropic 的 thinking `signature`（上游要求下一轮原样回传，改一个字节
 * 就会 400）、Responses 的 `encrypted_content`。转换器不解释它的内容，只负责
 * 「谁产生的、还给谁」。
 */
export interface IrOpaque {
  protocol: ProtocolId
  payload: unknown
}

export interface IrTextBlock {
  kind: 'text'
  text: string
}

export interface IrImageBlock {
  kind: 'image'
  mediaType: string
  /** base64，不带 data: 前缀 */
  dataBase64: string
}

export interface IrReasoningBlock {
  kind: 'reasoning'
  text: string
  /** 上游的签名/加密载荷，原样带回 */
  opaque: IrOpaque | null
}

export interface IrToolCallBlock {
  kind: 'tool_call'
  /** 跨协议稳定的调用 id——工具结果靠它配对，绝不能重新生成 */
  callId: string
  name: string
  /** 原始 JSON 字符串。不预先 parse：上游可能吐出非法 JSON，解释权交给最终消费者 */
  argumentsJson: string
  opaque: IrOpaque | null
}

/** 工具结果里允许出现的块——不能再嵌套工具调用 */
export type IrToolResultContent = IrTextBlock | IrImageBlock

export interface IrToolResultBlock {
  kind: 'tool_result'
  callId: string
  content: IrToolResultContent[]
  isError: boolean
}

export type IrBlock =
  IrTextBlock | IrImageBlock | IrReasoningBlock | IrToolCallBlock | IrToolResultBlock

/**
 * IR 只有 user / assistant 两种角色。
 * 系统提示走 `IrRequest.system`（Responses 的 `instructions` 和 Anthropic 的 `system`
 * 都是顶层字段，只有 Chat 需要把它降级成一条消息）。
 * 工具结果按 Anthropic 的约定归到 user 消息里。
 */
export type IrRole = 'user' | 'assistant'

export interface IrMessage {
  role: IrRole
  blocks: IrBlock[]
}

export interface IrTool {
  name: string
  description: string
  /** JSON Schema 对象。空对象表示无参数。 */
  parameters: Record<string, unknown>
}

export type IrToolChoice =
  { mode: 'auto' } | { mode: 'none' } | { mode: 'required' } | { mode: 'tool'; name: string }

export interface IrRequest {
  model: string
  /** 系统提示，已按顺序拼好 */
  system: string
  messages: IrMessage[]
  tools: IrTool[]
  toolChoice: IrToolChoice
  maxOutputTokens: number | null
  temperature: number | null
  topP: number | null
  reasoning: { enabled: boolean; effort: IrEffort | null }
  stream: boolean
  /** 原始请求体逐字保留，同协议直通时优先用它 */
  vendor: { protocol: ProtocolId; body: unknown }
}

// ---------------------------------------------------------------------------
// 流式事件
// ---------------------------------------------------------------------------

export type IrStopReason =
  'completed' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'refusal' | 'error'

export interface IrUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
}

/** block_start 携带的类型信息——决定后续 delta 该往哪儿灌 */
export type IrStreamBlockStart =
  { kind: 'text' } | { kind: 'reasoning' } | { kind: 'tool_call'; callId: string; name: string }

/**
 * 归一化的流式事件。
 *
 * 刻意做成「带 index 的块生命周期」而不是「平铺的 delta」：Responses 和 Anthropic
 * 本来就都是这个形状，直接对应；将来接 Chat Completions 时，由 Chat 的 decoder
 * 自己去合成 index 和 start/end 边界——把那套脏活关在一个文件里，不外溢。
 */
export type IrStreamEvent =
  | { type: 'start'; responseId: string; model: string }
  | { type: 'block_start'; index: number; block: IrStreamBlockStart }
  | { type: 'block_delta'; index: number; delta: string }
  /** 迟到的块元数据（如 Anthropic 的 signature_delta），只更新不产生可见输出 */
  | { type: 'block_meta'; index: number; opaque: IrOpaque }
  | { type: 'block_end'; index: number }
  | { type: 'usage'; usage: IrUsage }
  | { type: 'end'; stopReason: IrStopReason }
  | { type: 'error'; message: string; kind: string }

export function emptyUsage(): IrUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 }
}

/**
 * 把连续同角色的消息合并。
 *
 * Anthropic 要求 user/assistant 严格交替，而 Responses 的 input 里
 * `function_call` 和紧随其后的文本会被拆成两个 item（都归 assistant）。
 * 不合并的话上游直接 400。
 */
export function mergeAdjacentMessages(messages: IrMessage[]): IrMessage[] {
  const out: IrMessage[] = []
  for (const message of messages) {
    if (message.blocks.length === 0) continue
    const last = out[out.length - 1]
    if (last && last.role === message.role) {
      last.blocks.push(...message.blocks)
      continue
    }
    out.push({ role: message.role, blocks: [...message.blocks] })
  }
  return out
}
