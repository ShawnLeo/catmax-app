/**
 * codex app-server JSON-RPC 消息的 Zod schema。
 *
 * codex 协议是 newline-delimited JSON-RPC 2.0（线上省略 "jsonrpc":"2.0" header）。
 * 三类消息：request（带 id）、response（带 id 匹配 request）、notification（无 id）。
 *
 * 本文件只覆盖 Plan 2 用到的方法。完整协议见：
 * https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
 */
import { z } from 'zod'

// ============ 通用帧 ============

/** JSON-RPC 请求（client → server） */
export const jsonRpcRequestSchema = z.object({
  method: z.string(),
  id: z.union([z.number(), z.string()]),
  params: z.unknown().optional(),
})

/** JSON-RPC 响应（server → client，匹配请求） */
export const jsonRpcResponseSchema = z.object({
  id: z.union([z.number(), z.string()]),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
})

/** JSON-RPC 通知（server → client，无 id） */
export const jsonRpcNotificationSchema = z.object({
  method: z.string(),
  params: z.unknown(),
})

/** 任意 JSON-RPC 消息（解析后用 method 分发到具体 schema） */
export const jsonRpcMessageSchema = z.union([
  jsonRpcRequestSchema,
  jsonRpcResponseSchema,
  jsonRpcNotificationSchema,
])

// ============ initialize ============

export const initializeParamsSchema = z.object({
  clientInfo: z
    .object({
      name: z.string(),
      title: z.string().optional(),
      version: z.string(),
    })
    .optional(),
  capabilities: z
    .object({
      experimentalApi: z.boolean().optional(),
      optOutNotificationMethods: z.array(z.string()).optional(),
    })
    .optional(),
})

// ============ thread/start, turn/start ============

export const threadStartParamsSchema = z.object({
  cwd: z.string().optional(),
  model: z.string().optional(),
  sandbox: z.string().optional(),
  approvalPolicy: z.string().optional(),
})

export const turnStartParamsSchema = z.object({
  threadId: z.string(),
  input: z.union([z.string(), z.array(z.unknown())]).optional(),
  approvalPolicy: z.string().optional(),
  sandboxPolicy: z.unknown().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
})

// ============ Turn 事件（server → client notifications） ============

export const turnStartedParamsSchema = z.object({
  turn: z.object({
    id: z.string(),
    status: z.string(),
    items: z.array(z.unknown()).default([]),
  }),
})

export const turnCompletedParamsSchema = z.object({
  turn: z.object({
    id: z.string(),
    status: z.enum(['completed', 'interrupted', 'failed']),
    items: z.array(z.unknown()).default([]),
    error: z.unknown().optional(),
  }),
})

// ============ Item 事件 ============

/** item/agentMessage/delta —— 流式文本 */
export const agentMessageDeltaParamsSchema = z.object({
  itemId: z.string(),
  delta: z.string(),
})

/** item/started / item/completed 的 item 联合类型（覆盖 Plan 2 用到的几种） */
const commandExecutionItemSchema = z.object({
  type: z.literal('command_execution'),
  id: z.string(),
  command: z.string(),
  cwd: z.string().optional(),
  status: z.string(),
  aggregatedOutput: z.string().optional(),
  exitCode: z.number().optional(),
  durationMs: z.number().optional(),
})

const fileChangeItemSchema = z.object({
  type: z.literal('file_change'),
  id: z.string(),
  changes: z.array(
    z.object({
      path: z.string(),
      kind: z.string(),
      diff: z.string().optional(),
    }),
  ),
  status: z.string(),
})

const agentMessageItemSchema = z.object({
  type: z.literal('agent_message'),
  id: z.string(),
  text: z.string(),
})

const reasoningItemSchema = z.object({
  type: z.literal('reasoning'),
  id: z.string(),
  summary: z.array(z.unknown()).default([]),
  content: z.array(z.unknown()).default([]),
})

const userMessageItemSchema = z.object({
  type: z.literal('user_message'),
  id: z.string(),
  content: z.array(z.unknown()).default([]),
})

const mcpToolCallItemSchema = z.object({
  type: z.literal('mcp_tool_call'),
  id: z.string(),
  server: z.string(),
  tool: z.string(),
  status: z.string(),
  arguments: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
})

/** codex item 联合（新增类型时在这里加） */
export const codexItemSchema = z.union([
  commandExecutionItemSchema,
  fileChangeItemSchema,
  agentMessageItemSchema,
  reasoningItemSchema,
  userMessageItemSchema,
  mcpToolCallItemSchema,
  // 未知 item 类型用 passthrough 接住（不阻塞流）
  z.object({ type: z.string(), id: z.string() }).passthrough(),
])

export const itemStartedParamsSchema = z.object({
  threadId: z.string().optional(),
  itemId: z.string().optional(),
  item: codexItemSchema,
})

export const itemCompletedParamsSchema = z.object({
  threadId: z.string().optional(),
  itemId: z.string().optional(),
  item: codexItemSchema,
})

// ============ Approval 请求（server → client request，需要响应） ============

export const commandApprovalParamsSchema = z.object({
  itemId: z.string(),
  threadId: z.string(),
  turnId: z.string(),
  reason: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  commandActions: z.array(z.unknown()).optional(),
  availableDecisions: z.array(z.string()).optional(),
})

export const fileChangeApprovalParamsSchema = z.object({
  itemId: z.string(),
  threadId: z.string(),
  turnId: z.string(),
  reason: z.string().optional(),
})

// ============ Type 导出 ============

export type JsonRpcMessage = z.infer<typeof jsonRpcMessageSchema>
export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>
export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>
export type JsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>
export type CodexItem = z.infer<typeof codexItemSchema>
