/**
 * Claude CLI stream-json 协议的 Zod schema。
 *
 * claude -p --output-format stream-json 输出 newline-delimited JSON。
 * 三类顶层消息：system（启动握手）、assistant（流式助手消息）、result（turn 结束）。
 *
 * 完整字段参考：claude --help + 实际输出观察
 */
import { z } from 'zod'

// ============ 顶层消息 type 字段 ============

export const claudeMessageTypeSchema = z.enum([
  'system',
  'assistant',
  'user',
  'result',
  'stream_event',
])

// ============ system 消息（启动时一条 / 子 Agent 生命周期通知） ============

export const systemMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.string().optional(), // 'init' | 'task_started' | 'task_notification'
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  claude_code_version: z.string().optional(),
  // task_started：子 Agent 启动（claude CLI 调 Agent 工具时）
  task_id: z.string().optional(),
  tool_use_id: z.string().optional(),
  description: z.string().optional(),
  task_type: z.string().optional(), // 'local_agent' | ...
  prompt: z.string().optional(),
  // task_notification：子 Agent 完成
  status: z.string().optional(), // 'completed' | 'failed' | ...
  output_file: z.string().optional(), // 子 Agent jsonl 路径（空字符串表示无）
  summary: z.string().optional(),
  usage: z
    .object({
      total_tokens: z.number().optional(),
      tool_uses: z.number().optional(),
      duration_ms: z.number().optional(),
    })
    .optional(),
})

// ============ assistant 消息（一条或多条，含流式内容） ============

/** text 内容块 */
export const textContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

/** tool_use 内容块 */
export const toolUseContentSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
})

/** tool_result 内容块（出现在后续 user 消息里） */
export const toolResultContentSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.unknown())]).optional(),
  is_error: z.boolean().optional(),
})

/** thinking 内容块（reasoning） */
export const thinkingContentSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
})

/** 内容块联合 */
export const contentBlockSchema = z.union([
  textContentSchema,
  toolUseContentSchema,
  toolResultContentSchema,
  thinkingContentSchema,
  // 未知类型用 passthrough
  z.object({ type: z.string() }).passthrough(),
])

/** assistant 消息里的 message 子结构 */
export const claudeMessageSchema = z.object({
  id: z.string(),
  type: z.literal('message'),
  role: z.literal('assistant'),
  model: z.string().optional(),
  content: z.array(contentBlockSchema),
  stop_reason: z.string().nullable().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
})

export const assistantMessageSchema = z.object({
  type: z.literal('assistant'),
  message: claudeMessageSchema,
  parent_tool_use_id: z.string().nullable().optional(),
  session_id: z.string().optional(),
})

// ============ user 消息（assistant 之后的 tool_result） ============

/**
 * tool_use_result 字段：Task（子 Agent）完成时 claude CLI 附加的统计信息。
 * 出现在 user 消息的**顶层**（不在 message.content 里），只有 Task 工具的 tool_result 才带。
 * 包含 agentId / 总耗时 / token 数 / 工具调用次数 / 工具统计（bashCount/readCount 等）。
 */

export const toolUseResultSchema = z
  .object({
    status: z.string().optional(),
    prompt: z.string().optional(),
    agentId: z.string().optional(),
    agentType: z.string().optional(),
    content: z.union([z.string(), z.array(z.unknown())]).optional(),
    totalDurationMs: z.number().optional(),
    totalTokens: z.number().optional(),
    totalToolUseCount: z.number().optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        cache_read_input_tokens: z.number().optional(),
      })
      .optional(),
    toolStats: z
      .object({
        readCount: z.number().optional(),
        searchCount: z.number().optional(),
        bashCount: z.number().optional(),
        editFileCount: z.number().optional(),
        linesAdded: z.number().optional(),
        linesRemoved: z.number().optional(),
        otherToolCount: z.number().optional(),
      })
      .optional(),
  })
  .passthrough()

export const userMessageSchema = z.object({
  type: z.literal('user'),
  message: z.object({
    role: z.literal('user'),
    content: z.array(contentBlockSchema),
  }),
  session_id: z.string().optional(),
  // Task（子 Agent）完成时带这个顶层字段--子 Agent 的耗时 / token / 工具统计
  tool_use_result: toolUseResultSchema.optional(),
})

// ============ result 消息（turn 结束） ============

export const resultMessageSchema = z.object({
  type: z.literal('result'),
  subtype: z.string(), // 'success' | 'error_max_budget_usd' | 'error_during_execution' | ...
  duration_ms: z.number().optional(),
  duration_api_ms: z.number().optional(),
  is_error: z.boolean(),
  num_turns: z.number().optional(),
  result: z.string().optional(), // 最终文本（success 时）
  session_id: z.string().optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
    })
    .optional(),
  errors: z.array(z.string()).optional(),
})

// ============ stream_event 消息（加 --include-partial-messages 后逐 token 流） ============
//
// Claude 的 --include-partial-messages 模式下，每个 token 增量都包成一个 stream_event，
// event 字段就是 Anthropic Messages API 的标准 streaming event：
//   https://docs.anthropic.com/en/api/messages-streaming
//
// 关键 event.type：
//   message_start / message_delta / message_stop     - message 级生命周期
//   content_block_start / content_block_stop         - content block 级生命周期（带 index）
//   content_block_delta                              - 真正的 token 增量
//     - delta.type = 'text_delta' / 'thinking_delta' / 'input_json_delta'
//     - delta.text / delta.thinking / delta.partial_json 是实际内容

/**
 * stream_event 的 delta 子结构。
 *
 * 三种已知子类型（带具体内容字段）：
 *   - text_delta: { type: 'text_delta', text: '...' }
 *   - thinking_delta: { type: 'thinking_delta', thinking: '...' }
 *   - input_json_delta: { type: 'input_json_delta', partial_json: '...' }
 *
 * 其他兜底：
 *   - message_delta 系列的 delta 没 type 字段（{ stop_reason, stop_sequence }），
 *     必须允许"无 type"的情况，否则整条 stream_event 被 union 拒绝
 *   - signature_delta 等未知 type 用 passthrough 容错
 */
export const streamDeltaSchema = z.union([
  z.object({ type: z.literal('text_delta'), text: z.string() }),
  z.object({ type: z.literal('thinking_delta'), thinking: z.string() }),
  z.object({ type: z.literal('input_json_delta'), partial_json: z.string() }),
  // 带 type 但未知的 delta——passthrough 容错（signature_delta 等）
  z.object({ type: z.string() }).passthrough(),
  // 完全没 type 字段的 delta（message_delta 的 stop_reason/stop_sequence 走这条）
  z.record(z.unknown()),
])
export type StreamDelta = z.infer<typeof streamDeltaSchema>

/** content_block_start 携带的 block 描述（用于建立 index → block.type 映射） */
export const streamContentBlockSchema = z
  .object({
    type: z.string(), // 'text' | 'thinking' | 'tool_use' | ...
    // tool_use 时有 id 和 name；text/thinking 时有空字符串占位
    id: z.string().optional(),
    name: z.string().optional(),
    text: z.string().optional(),
    thinking: z.string().optional(),
  })
  .passthrough()
export type StreamContentBlock = z.infer<typeof streamContentBlockSchema>

/** stream_event.event 子结构（passthrough 容错未知 event.type） */
export const streamEventPayloadSchema = z
  .object({
    type: z.string(), // 'message_start' | 'content_block_delta' | ...
    index: z.number().optional(), // block index（content_block_* 系列必有）
    delta: streamDeltaSchema.optional(), // content_block_delta 必有
    content_block: streamContentBlockSchema.optional(), // content_block_start 必有
    message: z.unknown().optional(), // message_start / message_delta 用
  })
  .passthrough()

export const streamEventMessageSchema = z.object({
  type: z.literal('stream_event'),
  event: streamEventPayloadSchema,
  session_id: z.string().optional(),
  parent_tool_use_id: z.string().nullable().optional(),
})
export type StreamEventMessage = z.infer<typeof streamEventMessageSchema>

// ============ 顶层联合 ============

export const claudeStreamMessageSchema = z.union([
  systemMessageSchema,
  assistantMessageSchema,
  userMessageSchema,
  resultMessageSchema,
  streamEventMessageSchema,
])

// ============ Type 导出 ============

export type ClaudeStreamMessage = z.infer<typeof claudeStreamMessageSchema>
export type SystemMessage = z.infer<typeof systemMessageSchema>
export type AssistantMessage = z.infer<typeof assistantMessageSchema>
export type UserMessage = z.infer<typeof userMessageSchema>
export type ResultMessage = z.infer<typeof resultMessageSchema>
export type ContentBlock = z.infer<typeof contentBlockSchema>
export type TextContent = z.infer<typeof textContentSchema>
export type ToolUseContent = z.infer<typeof toolUseContentSchema>
export type ToolResultContent = z.infer<typeof toolResultContentSchema>
export type ThinkingContent = z.infer<typeof thinkingContentSchema>
