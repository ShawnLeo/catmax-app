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

export const claudeMessageTypeSchema = z.enum(['system', 'assistant', 'user', 'result'])

// ============ system 消息（启动时一条） ============

export const systemMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.string().optional(), // 'init'
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  claude_code_version: z.string().optional(),
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

export const userMessageSchema = z.object({
  type: z.literal('user'),
  message: z.object({
    role: z.literal('user'),
    content: z.array(contentBlockSchema),
  }),
  session_id: z.string().optional(),
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

// ============ 顶层联合 ============

export const claudeStreamMessageSchema = z.union([
  systemMessageSchema,
  assistantMessageSchema,
  userMessageSchema,
  resultMessageSchema,
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
