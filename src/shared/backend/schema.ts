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

const granularApprovalPolicySchema = z.object({
  granular: z.object({
    mcp_elicitations: z.boolean(),
    rules: z.boolean(),
    sandbox_approval: z.boolean(),
    request_permissions: z.boolean().optional(),
    skill_approval: z.boolean().optional(),
  }),
})

const approvalPolicySchema = z.union([z.string(), granularApprovalPolicySchema])

export const threadStartParamsSchema = z.object({
  cwd: z.string().optional(),
  model: z.string().optional(),
  sandbox: z.string().optional(),
  approvalPolicy: approvalPolicySchema.optional(),
})

export const turnStartParamsSchema = z.object({
  threadId: z.string(),
  input: z.union([z.string(), z.array(z.unknown())]).optional(),
  approvalPolicy: approvalPolicySchema.optional(),
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

export const reasoningDeltaParamsSchema = z.object({
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
  commandActions: z.array(z.unknown()).optional(),
  aggregatedOutput: z.string().nullish(),
  exitCode: z.number().nullish(),
  durationMs: z.number().nullish(),
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

const camelCommandExecutionItemSchema = commandExecutionItemSchema.extend({
  type: z.literal('commandExecution'),
})

const camelFileChangeItemSchema = fileChangeItemSchema.extend({
  type: z.literal('fileChange'),
})

const agentMessageItemSchema = z.object({
  type: z.literal('agent_message'),
  id: z.string(),
  text: z.string(),
  phase: z.enum(['commentary', 'final_answer']).nullish(),
})

const camelAgentMessageItemSchema = agentMessageItemSchema.extend({
  type: z.literal('agentMessage'),
})

const reasoningItemSchema = z.object({
  type: z.literal('reasoning'),
  id: z.string(),
  summary: z.array(z.unknown()).default([]),
  content: z.array(z.unknown()).default([]),
})

const textElementSchema = z
  .object({
    byteRange: z.object({ start: z.number(), end: z.number() }),
    placeholder: z.string().nullable(),
  })
  .passthrough()

/** 当前 App Server UserInput；input_* 两项兼容本地 rollout/旧桥接层。 */
export const codexUserInputSchema = z.union([
  z
    .object({
      type: z.literal('text'),
      text: z.string(),
      text_elements: z.array(textElementSchema).optional(),
    })
    .passthrough(),
  z
    .object({ type: z.literal('image'), url: z.string(), detail: z.string().optional() })
    .passthrough(),
  z
    .object({ type: z.literal('localImage'), path: z.string(), detail: z.string().optional() })
    .passthrough(),
  z.object({ type: z.literal('skill'), name: z.string(), path: z.string() }).passthrough(),
  z.object({ type: z.literal('mention'), name: z.string(), path: z.string() }).passthrough(),
  z.object({ type: z.literal('input_text'), text: z.string() }).passthrough(),
  z
    .object({
      type: z.literal('input_image'),
      image_url: z.string(),
      detail: z.string().optional(),
    })
    .passthrough(),
])

const userMessageContentSchema = z.union([
  z.string(),
  z.array(z.union([codexUserInputSchema, z.unknown()])),
])

const userMessageItemSchema = z
  .object({
    type: z.literal('user_message'),
    id: z.string(),
    content: userMessageContentSchema.default([]),
  })
  .passthrough()

const camelUserMessageItemSchema = userMessageItemSchema.extend({
  type: z.literal('userMessage'),
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

const camelMcpToolCallItemSchema = mcpToolCallItemSchema.extend({
  type: z.literal('mcpToolCall'),
})

/**
 * 现代 codex 的自定义工具调用 item（apply_patch / exec 等）。
 * apply_patch 的 input 是 V4 patch 文本（*** Begin Patch...），mapping 把它转成 file_change 活动。
 * 其他 name（exec 等）目前只接住不特殊处理。
 */
const customToolCallItemSchema = z.object({
  type: z.literal('custom_tool_call'),
  id: z.string(),
  call_id: z.string().optional(),
  name: z.string(),
  input: z.string().optional(),
  status: z.string().optional(),
})

/** codex item 联合（新增类型时在这里加） */
export const codexItemSchema = z.union([
  commandExecutionItemSchema,
  camelCommandExecutionItemSchema,
  fileChangeItemSchema,
  camelFileChangeItemSchema,
  agentMessageItemSchema,
  camelAgentMessageItemSchema,
  reasoningItemSchema,
  userMessageItemSchema,
  camelUserMessageItemSchema,
  mcpToolCallItemSchema,
  camelMcpToolCallItemSchema,
  customToolCallItemSchema,
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

export const commandExecutionOutputDeltaParamsSchema = z.object({
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  itemId: z.string(),
  delta: z.string(),
})

export const fileChangePatchUpdatedParamsSchema = z.object({
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  itemId: z.string(),
  changes: z.array(
    z.object({
      path: z.string(),
      kind: z.unknown(),
      diff: z.string().optional(),
    }),
  ),
})

export const turnDiffUpdatedParamsSchema = z.object({
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  diff: z.string(),
})

// ============ model/list ============

/**
 * codex app-server 的 model/list 响应 schema。
 *
 * codex 0.93+ 的 app-server 暴露这个方法返回**当前账户实际可用的**模型列表
 * （ChatGPT 登录态自动鉴权）。比起 OpenAI 公开的 GET /v1/models（返回全平台模型、
 * 不按账户过滤），这个才是用户真正能用的。
 *
 * 实测响应结构（codex-cli 0.93.0，ChatGPT 账户）：
 *   {
 *     data: [
 *       {
 *         id: "gpt-5.2-codex",                 // 传给 thread/start 的 model id
 *         model: "gpt-5.2-codex",              // 上游 API id（通常同 id）
 *         displayName: "gpt-5.2-codex",        // 展示名
 *         description: "Latest frontier...",
 *         supportedReasoningEfforts: [         // 注意是对象数组，不是字符串数组
 *           { reasoningEffort: "low", description: "..." },
 *           { reasoningEffort: "medium", description: "..." },
 *           ...
 *         ],
 *         defaultReasoningEffort: "medium",
 *         supportsPersonality: false,
 *         isDefault: true                      // 注意是 isDefault 不是 default
 *       },
 *       ...
 *     ],
 *     nextCursor: null                          // 分页游标（未启用时 null）
 *   }
 *
 * 注意：codex app-server README 写的是 `models` / `display_name` / `default` 等
 * snake_case 字段名，但**实际线上返回的是 camelCase + data + isDefault**。
 * README 跟实现对不上是 codex 那边的文档债，这里以实测为准。
 * schema 用 passthrough 兼容 codex 后续可能新增/改名（如 serviceTiers、upgradeInfo）。
 */
export const modelListParamsSchema = z.object({
  includeHidden: z.boolean().optional(),
})

export const modelListResultSchema = z
  .object({
    // 实测字段名是 data（不是 README 写的 models）；passthrough 容忍未知字段
    data: z
      .array(
        z
          .object({
            id: z.string(),
            // 上游 model id，目前同 id；保留兼容未来分离的情况
            model: z.string().optional(),
            // camelCase（不是 README 写的 display_name）
            displayName: z.string().optional(),
            description: z.string().optional(),
            // 对象数组，每个含 reasoningEffort + description
            supportedReasoningEfforts: z
              .array(
                z
                  .object({
                    reasoningEffort: z.string(),
                    description: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
            defaultReasoningEffort: z.string().optional(),
            // isDefault（不是 README 写的 default）
            isDefault: z.boolean().optional(),
          })
          .passthrough(),
      )
      .default([]),
    nextCursor: z.unknown().optional(),
  })
  .passthrough()

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

/**
 * MCP elicitation 是 MCP server（例如 Computer Use）向宿主客户端发起的交互请求。
 * `openai/form` 的 requestedSchema 对客户端是 opaque JSON，因此这里保留 unknown，
 * 由 adapter 只提取 CatMax 能安全理解的持久授权字段。
 */
const mcpServerElicitationContextSchema = z.object({
  threadId: z.string(),
  turnId: z.string().nullable(),
  serverName: z.string(),
})

const mcpServerElicitationPayloadSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('form'),
      message: z.string(),
      requestedSchema: z.unknown(),
      _meta: z.unknown().nullable(),
    })
    .passthrough(),
  z
    .object({
      mode: z.literal('openai/form'),
      message: z.string(),
      requestedSchema: z.unknown(),
      _meta: z.unknown().nullable(),
    })
    .passthrough(),
  z
    .object({
      mode: z.literal('url'),
      message: z.string(),
      url: z.string(),
      elicitationId: z.string(),
      _meta: z.unknown().nullable(),
    })
    .passthrough(),
])

export const mcpServerElicitationRequestParamsSchema = mcpServerElicitationContextSchema.and(
  mcpServerElicitationPayloadSchema,
)

// ============ Type 导出 ============

export type JsonRpcMessage = z.infer<typeof jsonRpcMessageSchema>
export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>
export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>
export type JsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>
export type CodexItem = z.infer<typeof codexItemSchema>
export type ModelListResult = z.infer<typeof modelListResultSchema>
export type McpServerElicitationRequestParams = z.infer<
  typeof mcpServerElicitationRequestParamsSchema
>
