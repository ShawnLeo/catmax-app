# Plan 3: Claude 适配器 + 完整侧边栏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Plan 2 的 codex-only 基础上加 Claude 适配器（验证 `AgentBackend` 抽象可插拔），并补全完整的侧边栏（会话列表 + 后端切换 + 工作区切换 + 只读会话浏览）。完成后产物：用户可在 codex 和 claude 之间一键切换，会话列表按后端分区显示（"可继续" vs "其他后端只读"），完整闭环的双后端 code agent 客户端。

**Architecture:** ClaudeAdapter 实现 `AgentBackend` 接口，把 claude CLI 的 `stream-json` 协议（newline-delimited JSON，system/assistant/result 三类消息）转译为统一的 `TurnEvent`。和 codex 不同——**claude 每次 turn 启动一个新进程**（`claude -p --resume <session_id>`），不是维持长连接；adapter 内部用 `cwd + sessionId` 维持进程间状态。侧边栏 ChatView 改为 Sidebar + MainContent 两栏布局，Sidebar 显示工作区/会话列表/后端指示器，会话按后端分区（当前后端的"可继续"、其他后端的"只读折叠"）。

**Tech Stack:** （已就位）Electron 31 + Vue 3 + electron-vite + Pinia + Tailwind v4 + shadcn-vue。**新增**：无（全部用已有依赖）。

**设计文档参考：** `docs/superpowers/specs/2026-07-18-catmax-app-design.md`（第三章 §3.5 切换后端的会话同步策略）
**项目规范：** `.agents/skills/catmax-conventions/references/backend-adapter.md`
**协议参考：** [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-reference)

---

## 关键设计决策（先读这部分）

### 决策 1：Claude adapter 的"会话"概念

codex 的 thread 是**长生命周期**的（`thread/start` 一次，后续 turn 都在同一个 thread）。
claude 的 session 是**进程级**的——每次 `claude -p` 都是一个独立进程，session_id 只用于"延续上下文"。

**适配策略**：
- `startSession(cwd)` → 不真启动进程，只生成 App 内部的 sessionId + 记录 cwd。真正启动发生在 `startTurn`。
- `startTurn(args)` → 真的 spawn `claude -p --output-format stream-json --input-format stream-json --verbose --resume <session_id>`，喂用户消息进 stdin，读 stdout 流式输出，turn 结束后**进程退出**。
- `resumeSession(sessionId)` → 不需要主动 resume，下次 startTurn 自动用 `--resume`。

### 决策 2：claude 没有 JSON-RPC，只有 newline-delimited JSON

- 没有"请求-响应配对"——claude 输出是单向流
- 没有"approval 反向请求"——claude 在 `permission-mode: default` 时会**停在 tool_use 等待** stdin 输入（特殊格式的 approval 消息）
- MVP 简化：**ClaudeAdapter 不支持 approval**（capabilities.supportsApproval = false），UI 隐藏 approval 按钮。`permission-mode: acceptEdits` 或 `auto` 时 claude 自动决策。

### 决策 3：claude turn 中断 = kill 进程

没有 codex 的 `turn/interrupt`。中断 = 杀子进程。Adapter 内部维护 `currentProc`，`interrupt()` 直接 `proc.kill('SIGTERM')`。

### 决策 4：会话归属不变（来自设计文档 §3.5）

- `sessions.backend` 字段永久 = 创建它的后端
- 切换当前后端**不**改变已有会话的 backend
- UI 分两区显示：当前后端的会话"可继续"，其他后端的"只读折叠"
- 跨后端继续聊天 → 拒绝（throw `BackendError('mismatch')`）

---

## 文件结构（本 plan 产出的所有文件）

```
catmax-app/
├─ src/
│  ├─ shared/
│  │  └─ backend/
│  │     └─ claude-schema.ts                   # 🆕 claude stream-json 消息的 Zod schema
│  │
│  ├─ main/
│  │  ├─ backend/
│  │  │  ├─ manager.ts                         # 📝 修改：注册 ClaudeAdapter、listStatuses 列所有后端
│  │  │  └─ claude/                            # 🆕 Claude 适配器三件套
│  │  │     ├─ adapter.ts                      # ClaudeAdapter implements AgentBackend
│  │  │     ├─ protocol.ts                     # newline JSON 解析（复用 codex 的 LineBuffer）
│  │  │     └─ mapping.ts                      # claude message → TurnEvent
│  │  └─ service/
│  │     ├─ database.ts                        # 📝 修改：sessions 表查询支持跨后端筛选
│  │     └─ claude-resolver.ts                 # 🆕 找 claude CLI 路径
│  │
│  └─ renderer/src/
│     ├─ views/
│     │  └─ ChatView.vue                       # 📝 修改：从单栏改为 Sidebar + MainContent 两栏
│     ├─ components/
│     │  ├─ sidebar/                           # 🆕 完整侧边栏
│     │  │  ├─ Sidebar.vue                     # 根容器
│     │  │  ├─ WorkspaceSwitcher.vue           # 顶部工作区切换
│     │  │  ├─ SessionList.vue                 # 会话列表（按后端分区）
│     │  │  ├─ SessionItem.vue                 # 单个会话条目
│     │  │  └─ BackendIndicator.vue            # 底部后端状态
│     │  └─ ui/
│     │     ├─ scroll-area/                    # 🆕 shadcn-vue 风格滚动区
│     │     │  ├─ ScrollArea.vue
│     │     │  └─ index.ts
│     │     └─ dropdown-menu/                  # 🆕 用于工作区切换
│     │        ├─ DropdownMenu.vue
│     │        ├─ DropdownMenuContent.vue
│     │        ├─ DropdownMenuItem.vue
│     │        ├─ DropdownMenuTrigger.vue
│     │        └─ index.ts
│     └─ stores/
│        └─ session.ts                         # 📝 修改：加 reconcile、跨后端会话视图
│
└─ tests/
   └─ backend/
      ├─ claude-protocol.test.ts               # 🆕
      ├─ claude-mapping.test.ts                # 🆕
      └─ claude-adapter.test.ts                # 🆕
```

---

## Task 1: Claude stream-json Zod schema

**Files:**
- Create: `src/shared/backend/claude-schema.ts`
- Test: `tests/backend/claude-protocol-schema.test.ts`

### Step 1: 创建 claude-schema.ts

Create `src/shared/backend/claude-schema.ts`：

```ts
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
```

### Step 2: 写 schema 单测

Create `tests/backend/claude-protocol-schema.test.ts`：

```ts
import { describe, expect, test } from 'vitest'
import {
  assistantMessageSchema,
  claudeStreamMessageSchema,
  resultMessageSchema,
  systemMessageSchema,
} from '@shared/backend/claude-schema'

describe('claude stream-json schema', () => {
  test('system init 消息解析', () => {
    const msg = {
      type: 'system',
      subtype: 'init',
      cwd: '/tmp',
      session_id: 'abc-123',
      model: 'claude-sonnet-4-6',
      permissionMode: 'default',
    }
    expect(systemMessageSchema.safeParse(msg).success).toBe(true)
  })

  test('assistant text 消息解析', () => {
    const msg = {
      type: 'assistant',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
      },
    }
    expect(assistantMessageSchema.safeParse(msg).success).toBe(true)
  })

  test('assistant tool_use 消息解析', () => {
    const msg = {
      type: 'assistant',
      message: {
        id: 'msg_2',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'Bash',
            input: { command: 'ls -la' },
          },
        ],
      },
    }
    expect(assistantMessageSchema.safeParse(msg).success).toBe(true)
  })

  test('assistant thinking 消息解析', () => {
    const msg = {
      type: 'assistant',
      message: {
        id: 'msg_3',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'let me think...' }],
      },
    }
    expect(assistantMessageSchema.safeParse(msg).success).toBe(true)
  })

  test('result success 消息解析', () => {
    const msg = {
      type: 'result',
      subtype: 'success',
      duration_ms: 1500,
      is_error: false,
      num_turns: 1,
      result: '4',
      session_id: 'abc-123',
      total_cost_usd: 0.001,
      usage: { input_tokens: 10, output_tokens: 5 },
    }
    expect(resultMessageSchema.safeParse(msg).success).toBe(true)
  })

  test('result error 消息解析', () => {
    const msg = {
      type: 'result',
      subtype: 'error_max_budget_usd',
      is_error: true,
      errors: ['Reached maximum budget ($0.05)'],
    }
    expect(resultMessageSchema.safeParse(msg).success).toBe(true)
  })

  test('未知 content block 用 passthrough 接住', () => {
    const msg = {
      type: 'assistant',
      message: {
        id: 'msg_x',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'some_future_block', custom: 'data' }],
      },
    }
    expect(assistantMessageSchema.safeParse(msg).success).toBe(true)
  })

  test('顶层联合消息分发', () => {
    const system = { type: 'system', subtype: 'init' }
    const assistant = {
      type: 'assistant',
      message: { id: 'm', type: 'message', role: 'assistant', content: [] },
    }
    const result = { type: 'result', subtype: 'success', is_error: false }

    expect(claudeStreamMessageSchema.safeParse(system).success).toBe(true)
    expect(claudeStreamMessageSchema.safeParse(assistant).success).toBe(true)
    expect(claudeStreamMessageSchema.safeParse(result).success).toBe(true)
  })
})
```

### Step 3: 测试 + commit

```bash
pnpm rebuild:node
pnpm test tests/backend/claude-protocol-schema.test.ts
pnpm typecheck && pnpm lint
git add src/shared/backend/claude-schema.ts tests/backend/claude-protocol-schema.test.ts
git commit -m "feat(backend): add claude stream-json Zod schemas with tests"
```

---

## Task 2: Claude event → TurnEvent mapping

**Files:**
- Create: `src/main/backend/claude/mapping.ts`
- Test: `tests/backend/claude-mapping.test.ts`

### Step 1: 创建 mapping.ts

Create `src/main/backend/claude/mapping.ts`：

```ts
/**
 * Claude stream-json message → TurnEvent 转译层。
 *
 * Claude 的内容块（content blocks）模型：
 * - text → text_delta（累积）
 * - thinking → reasoning_delta
 * - tool_use → tool_call_started
 * - tool_result（在后续 user 消息里）→ tool_call_completed
 */
import type {
  AssistantMessage,
  ContentBlock,
  ResultMessage,
  TextContent,
  ThinkingContent,
  ToolResultContent,
  ToolUseContent,
} from '@shared/backend/claude-schema'
import type { ToolCallInfo, ToolOutput, TurnEvent } from '@shared/backend/types'
import { randomUUID } from 'node:crypto'

/** 把 claude 的 tool_use 映射到 ToolCallInfo */
export function toolUseToInfo(block: ToolUseContent): ToolCallInfo {
  const input = block.input as Record<string, unknown> | undefined
  switch (block.name) {
    case 'Bash':
      return {
        kind: 'shell_command',
        title: typeof input?.command === 'string' ? input.command.slice(0, 80) : block.name,
        detail: typeof input?.command === 'string' ? input.command : JSON.stringify(input),
      }
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return {
        kind: 'file_edit',
        title: typeof input?.file_path === 'string' ? `${block.name}: ${input.file_path}` : block.name,
        detail: JSON.stringify(input, null, 2),
      }
    case 'Read':
    case 'Glob':
    case 'Grep':
      return {
        kind: 'file_read',
        title: typeof input?.file_path === 'string' ? `${block.name}: ${input.file_path}` : block.name,
        detail: JSON.stringify(input, null, 2),
      }
    default:
      // MCP tools 形如 mcp__server__tool
      if (block.name.startsWith('mcp__')) {
        return {
          kind: 'mcp',
          title: block.name,
          detail: JSON.stringify(input, null, 2),
        }
      }
      return {
        kind: 'other',
        title: block.name,
        detail: JSON.stringify(input, null, 2),
      }
  }
}

/** 把 claude 的 tool_result 内容块映射到 ToolOutput */
export function toolResultToOutput(block: ToolResultContent): ToolOutput {
  const isError = block.is_error === true
  let output: string | undefined
  if (typeof block.content === 'string') {
    output = block.content
  } else if (Array.isArray(block.content)) {
    // content 可能是 [{type: 'text', text: '...'}]
    output = block.content
      .map((c: unknown) =>
        typeof c === 'object' && c !== null && 'text' in c
          ? String((c as { text: unknown }).text)
          : String(c),
      )
      .join('\n')
  }

  return {
    ok: !isError,
    summary: isError ? 'failed' : 'completed',
    output,
  }
}

/** 从 assistant 消息提取事件序列 */
export function* assistantToEvents(
  msg: AssistantMessage,
  turnId: string,
): Iterable<TurnEvent> {
  for (const block of msg.message.content) {
    const itemId = blockId(block)
    switch (block.type) {
      case 'text': {
        const text = (block as TextContent).text
        yield { type: 'text_delta', turnId, itemId, text }
        break
      }
      case 'thinking': {
        const text = (block as ThinkingContent).thinking
        yield { type: 'reasoning_delta', turnId, itemId, text }
        break
      }
      case 'tool_use': {
        const tool = toolUseToInfo(block as ToolUseContent)
        yield { type: 'tool_call_started', turnId, itemId, tool }
        break
      }
      // tool_result 在 user 消息里，不在这里处理
      default:
        break
    }
  }
}

/** 从 user 消息（含 tool_result）提取 tool_call_completed 事件 */
export function* userToolResultToEvents(
  msg: { message: { content: ContentBlock[] } },
  turnId: string,
): Iterable<TurnEvent> {
  for (const block of msg.message.content) {
    if (block.type === 'tool_result') {
      const result = block as ToolResultContent
      const itemId = result.tool_use_id
      yield {
        type: 'tool_call_completed',
        turnId,
        itemId,
        output: toolResultToOutput(result),
      }
    }
  }
}

/** result 消息 → turn_completed 事件 */
export function resultToEvent(msg: ResultMessage, turnId: string): TurnEvent {
  const status: 'completed' | 'interrupted' | 'error' = msg.is_error
    ? 'error'
    : msg.subtype === 'interrupted'
      ? 'interrupted'
      : 'completed'
  return {
    type: 'turn_completed',
    turnId,
    status,
    usage: msg.usage
      ? {
          inputTokens: msg.usage.input_tokens,
          outputTokens: msg.usage.output_tokens,
          cacheReadTokens: msg.usage.cache_read_input_tokens,
          costUsd: msg.total_cost_usd,
        }
      : undefined,
  }
}

/** content block 取 id（tool_use 有 id，其他生成） */
function blockId(block: ContentBlock): string {
  if (block.type === 'tool_use') {
    return (block as ToolUseContent).id
  }
  return randomUUID()
}
```

### Step 2: 写 mapping 单测

Create `tests/backend/claude-mapping.test.ts`：

```ts
import { describe, expect, test } from 'vitest'
import {
  assistantToEvents,
  resultToEvent,
  toolResultToOutput,
  toolUseToInfo,
} from '@main/backend/claude/mapping'

describe('claude toolUseToInfo', () => {
  test('Bash 工具映射为 shell_command', () => {
    const info = toolUseToInfo({
      type: 'tool_use',
      id: 't1',
      name: 'Bash',
      input: { command: 'git status' },
    })
    expect(info.kind).toBe('shell_command')
    expect(info.title).toBe('git status')
    expect(info.detail).toBe('git status')
  })

  test('Edit 工具映射为 file_edit', () => {
    const info = toolUseToInfo({
      type: 'tool_use',
      id: 't2',
      name: 'Edit',
      input: { file_path: '/foo/bar.ts', old_string: 'a', new_string: 'b' },
    })
    expect(info.kind).toBe('file_edit')
    expect(info.title).toContain('/foo/bar.ts')
  })

  test('Read 工具映射为 file_read', () => {
    const info = toolUseToInfo({
      type: 'tool_use',
      id: 't3',
      name: 'Read',
      input: { file_path: '/foo.txt' },
    })
    expect(info.kind).toBe('file_read')
  })

  test('MCP 工具映射为 mcp', () => {
    const info = toolUseToInfo({
      type: 'tool_use',
      id: 't4',
      name: 'mcp__chrome__click',
      input: { selector: '#btn' },
    })
    expect(info.kind).toBe('mcp')
    expect(info.title).toBe('mcp__chrome__click')
  })

  test('未知工具映射为 other', () => {
    const info = toolUseToInfo({
      type: 'tool_use',
      id: 't5',
      name: 'SomeNewTool',
      input: { x: 1 },
    })
    expect(info.kind).toBe('other')
  })
})

describe('claude toolResultToOutput', () => {
  test('成功 + 字符串 content', () => {
    const out = toolResultToOutput({
      type: 'tool_result',
      tool_use_id: 't1',
      content: 'done',
    })
    expect(out.ok).toBe(true)
    expect(out.summary).toBe('completed')
    expect(out.output).toBe('done')
  })

  test('失败', () => {
    const out = toolResultToOutput({
      type: 'tool_result',
      tool_use_id: 't1',
      content: 'error msg',
      is_error: true,
    })
    expect(out.ok).toBe(false)
    expect(out.summary).toBe('failed')
  })

  test('数组 content 拼接', () => {
    const out = toolResultToOutput({
      type: 'tool_result',
      tool_use_id: 't1',
      content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }],
    })
    expect(out.output).toBe('line1\nline2')
  })
})

describe('claude assistantToEvents', () => {
  test('text 块 → text_delta', () => {
    const events = Array.from(
      assistantToEvents(
        {
          type: 'assistant',
          message: {
            id: 'm1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
          },
        },
        'turn1',
      ),
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'text_delta', text: 'hello', turnId: 'turn1' })
  })

  test('thinking 块 → reasoning_delta', () => {
    const events = Array.from(
      assistantToEvents(
        {
          type: 'assistant',
          message: {
            id: 'm1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'hmm' }],
          },
        },
        'turn1',
      ),
    )
    expect(events[0]).toMatchObject({ type: 'reasoning_delta', text: 'hmm' })
  })

  test('tool_use 块 → tool_call_started', () => {
    const events = Array.from(
      assistantToEvents(
        {
          type: 'assistant',
          message: {
            id: 'm1',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool_1',
                name: 'Bash',
                input: { command: 'ls' },
              },
            ],
          },
        },
        'turn1',
      ),
    )
    expect(events[0]).toMatchObject({
      type: 'tool_call_started',
      itemId: 'tool_1',
      tool: { kind: 'shell_command' },
    })
  })

  test('混合 content 块产生多个事件', () => {
    const events = Array.from(
      assistantToEvents(
        {
          type: 'assistant',
          message: {
            id: 'm1',
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'text', text: 'running' },
              { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
            ],
          },
        },
        'turn1',
      ),
    )
    expect(events).toHaveLength(2)
  })
})

describe('claude resultToEvent', () => {
  test('success → turn_completed', () => {
    const event = resultToEvent(
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        total_cost_usd: 0.001,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      'turn1',
    )
    expect(event.type).toBe('turn_completed')
    expect(event).toHaveProperty('status', 'completed')
    expect(event).toHaveProperty('usage')
  })

  test('error → turn_completed with status=error', () => {
    const event = resultToEvent(
      {
        type: 'result',
        subtype: 'error_max_budget_usd',
        is_error: true,
      },
      'turn1',
    )
    expect(event).toHaveProperty('status', 'error')
  })
})
```

### Step 3: 测试 + commit

```bash
pnpm test tests/backend/claude-mapping.test.ts
pnpm typecheck && pnpm lint
git add src/main/backend/claude/mapping.ts tests/backend/claude-mapping.test.ts
git commit -m "feat(backend): add claude message to TurnEvent mapping"
```

---

## Task 3: ClaudeAdapter

**Files:**
- Create: `src/main/backend/claude/protocol.ts`（小，复用 codex 的 LineBuffer）
- Create: `src/main/backend/claude/adapter.ts`
- Test: `tests/backend/claude-adapter.test.ts`

### Step 1: 创建 claude/protocol.ts

Create `src/main/backend/claude/protocol.ts`：

```ts
/**
 * Claude CLI 协议层。
 *
 * Claude 用 newline-delimited JSON（不是 JSON-RPC），单向流。
 * 这里复用 codex 的 LineBuffer（同行），只加 claude 特有的 encode 函数。
 */
import { LineBuffer } from '../codex/protocol'
import { claudeStreamMessageSchema, type ClaudeStreamMessage } from '@shared/backend/claude-schema'
import { logger } from '@main/service/logger'

const log = logger.domain('claude-protocol')

export { LineBuffer }

/** 解析单行 claude 消息 */
export function parseClaudeLine(line: string): ClaudeStreamMessage | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (e) {
    log.warn('failed to parse claude JSON line:', trimmed.slice(0, 200), e)
    return null
  }

  const result = claudeStreamMessageSchema.safeParse(parsed)
  if (!result.success) {
    log.warn('claude message failed schema:', result.error.issues.slice(0, 2))
    return null
  }
  return result.data
}

/** 序列化要写入 claude stdin 的 user 消息 */
export function encodeUserMessage(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: text,
    },
  })
}
```

### Step 2: 创建 claude/adapter.ts

Create `src/main/backend/claude/adapter.ts`：

```ts
/**
 * ClaudeAdapter —— claude CLI 的 AgentBackend 实现。
 *
 * 和 codex 不同：
 * - 每次 turn 启动一个新 claude 进程（不是长连接）
 * - 用 --resume <session_id> 续接会话
 * - 没有反向 approval 请求（permission-mode 自动决策）
 * - 中断 = kill 进程
 */
import { randomUUID } from 'node:crypto'

import {
  type AssistantMessage,
  type ResultMessage,
} from '@shared/backend/claude-schema'
import {
  BackendError,
  type AgentBackend,
  type ApprovalDecision,
  type BackendCapabilities,
  type ModelOption,
  type SessionSummary,
  type StartSessionArgs,
  type StartTurnArgs,
  type TurnEvent,
} from '@shared/backend/types'
import { logger } from '@main/service/logger'
import { ProcessSpawner, RealProcessSpawner } from '../process-spawner'
import { assistantToEvents, resultToEvent, userToolResultToEvents } from './mapping'
import { LineBuffer, encodeUserMessage, parseClaudeLine } from './protocol'

const log = logger.domain('claude-adapter')

export interface ClaudeAdapterOptions {
  binaryPath?: string
  spawner?: ProcessSpawner
  cwd?: string
}

export class ClaudeAdapter implements AgentBackend {
  readonly id = 'claude' as const

  readonly capabilities: BackendCapabilities = {
    supportsInterrupt: true,
    supportsApproval: false, // claude MVP 不支持 approval UI
    supportsSteer: false,
    supportsThreadFork: false,
    supportsModelSelection: true,
    supportsEffort: true,
    supportsPermissionMode: true,
    supportedPermissionModes: ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'],
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  }

  private opts: ClaudeAdapterOptions
  private spawner: ProcessSpawner

  /** 当前 turn 的子进程（用于 interrupt） */
  private currentProc: ReturnType<ProcessSpawner['spawn']> | null = null
  /** cwd → claude session_id 映射（claude 在第一次 turn 时返回 session_id） */
  private sessionMap = new Map<string, string>()
  /** internal session id → claude session id 反向映射 */
  private sessionIdMap = new Map<string, string>()

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.opts = opts
    this.spawner = opts.spawner ?? new RealProcessSpawner()
  }

  async initialize(): Promise<void> {
    // claude 不需要预初始化——每次 turn 启动新进程
    log.info('initialized (lazy, per-turn)')
  }

  async healthCheck(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const { execSync } = await import('node:child_process')
      const binary = this.opts.binaryPath ?? 'claude'
      const output = execSync(`${binary} --version`, { encoding: 'utf-8', timeout: 5000 })
      return { ok: true, version: output.trim() }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      return {
        ok: false,
        error: code === 'ENOENT' ? 'not-installed' : 'spawn-failed',
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.currentProc) {
      this.currentProc.kill('SIGTERM')
      this.currentProc = null
    }
    log.info('disposed')
  }

  getCapabilities(): BackendCapabilities {
    return this.capabilities
  }

  async listModels(): Promise<ModelOption[]> {
    // claude 不像 codex 那样有 model/list，返回固定的常用模型
    return [
      { id: 'sonnet', displayName: 'Claude Sonnet (latest)', isDefault: true },
      { id: 'opus', displayName: 'Claude Opus (latest)' },
      { id: 'haiku', displayName: 'Claude Haiku (latest)' },
    ]
  }

  async startSession(args: StartSessionArgs): Promise<{ sessionId: string; backendThreadId: string }> {
    // claude session 是进程级的，不预创建。生成 App 内部 id 即可。
    const sessionId = randomUUID()
    // backendThreadId 等于 sessionId（claude 第一次 turn 时会返回真实 session_id，我们记下映射）
    this.sessionIdMap.set(sessionId, sessionId) // 临时占位，第一次 turn 后更新
    return {
      sessionId,
      backendThreadId: sessionId,
    }
  }

  async listSessions(cwd?: string): Promise<SessionSummary[]> {
    // MVP：claude 不维护可枚举的 session 列表（要 `claude --resume` 才能看到，且不友好）
    // 返回空——App db 里有索引即可
    void cwd
    return []
  }

  async resumeSession(backendThreadId: string): Promise<{ messages: never[] }> {
    // 不需要主动 resume——下次 startTurn 会用 --resume
    void backendThreadId
    return { messages: [] }
  }

  async *startTurn(args: StartTurnArgs): AsyncIterable<TurnEvent> {
    const internalTurnId = randomUUID()
    yield { type: 'turn_started', turnId: internalTurnId, sessionId: args.sessionId }

    // 找 claude session_id
    const claudeSessionId = this.sessionIdMap.get(args.sessionId) ?? args.sessionId

    // 启动 claude 进程
    const binary = this.opts.binaryPath ?? 'claude'
    const procArgs = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--resume', claudeSessionId,
    ]
    if (args.model) {
      procArgs.push('--model', args.model)
    }
    if (args.effort) {
      procArgs.push('--effort', args.effort)
    }
    if (args.permissionMode) {
      procArgs.push('--permission-mode', args.permissionMode)
    }

    this.currentProc = this.spawner.spawn({
      command: binary,
      args: procArgs,
      cwd: this.opts.cwd,
    })

    // 写用户消息到 stdin 并 close（claude 一次只处理一条 user 消息）
    this.currentProc.write(encodeUserMessage(args.prompt) + '\n')
    this.currentProc.endInput()

    // 读 stdout 流，转 TurnEvent
    const queue: TurnEvent[] = []
    let resolveWait: (() => void) | null = null
    let done = false
    const lineBuffer = new LineBuffer()

    const onChunk = (chunk: Buffer) => {
      const lines = lineBuffer.push(chunk)
      for (const line of lines) {
        const msg = parseClaudeLine(line)
        if (!msg) continue
        if (msg.type === 'system') {
          // 记下 claude 真实 session_id
          if (msg.session_id) {
            this.sessionIdMap.set(args.sessionId, msg.session_id)
          }
          continue
        }
        if (msg.type === 'assistant') {
          for (const event of assistantToEvents(msg as AssistantMessage, internalTurnId)) {
            queue.push(event)
            resolveWait?.()
          }
          continue
        }
        if (msg.type === 'user') {
          for (const event of userToolResultToEvents(msg, internalTurnId)) {
            queue.push(event)
            resolveWait?.()
          }
          continue
        }
        if (msg.type === 'result') {
          queue.push(resultToEvent(msg as ResultMessage, internalTurnId))
          resolveWait?.()
          done = true
        }
      }
    }

    this.currentProc.child.stdout?.on('data', onChunk)
    this.currentProc.child.on('exit', () => {
      done = true
      resolveWait?.()
    })

    try {
      while (!done || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resolveWait = resolve
          })
          resolveWait = null
        }
        while (queue.length > 0) {
          const event = queue.shift()!
          yield event
          if (event.type === 'turn_completed' || event.type === 'error') {
            this.currentProc = null
            return
          }
        }
      }
    } finally {
      this.currentProc = null
    }
  }

  async interrupt(turnId: string): Promise<void> {
    void turnId
    if (this.currentProc) {
      log.info('interrupting claude process')
      this.currentProc.kill('SIGTERM')
      this.currentProc = null
    }
  }

  async respondApproval(decision: ApprovalDecision): Promise<void> {
    // claude MVP 不支持 approval
    void decision
    log.warn('respondApproval called but claude does not support approval')
  }
}
```

### Step 3: 写 adapter 单测

Create `tests/backend/claude-adapter.test.ts`：

```ts
import { describe, expect, test, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { ClaudeAdapter } from '@main/backend/claude/adapter'
import type { ProcessSpawner, SpawnedProcess } from '@main/backend/process-spawner'

function createMockSpawner(): { spawner: ProcessSpawner; stdout: PassThrough; stdin: PassThrough } {
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stdin: PassThrough
    pid: number
    kill: (sig?: NodeJS.Signals) => void
  }
  ;(child as any).stdout = stdout
  ;(child as any).stdin = stdin
  ;(child as any).pid = 12345
  ;(child as any).kill = vi.fn()

  const spawner: ProcessSpawner = {
    spawn(): SpawnedProcess {
      return {
        child: child as any,
        write: (data) => stdin.write(data),
        endInput: () => stdin.end(),
        kill: (sig) => (child as any).kill(sig),
        pid: 12345,
      }
    },
  }
  return { spawner, stdout, stdin }
}

function pushClaudeLine(stream: PassThrough, obj: unknown): void {
  stream.write(JSON.stringify(obj) + '\n')
}

describe('ClaudeAdapter', () => {
  test('startTurn 流式 text + 完成', async () => {
    const { spawner, stdout } = createMockSpawner()
    const adapter = new ClaudeAdapter({ spawner })

    // spawn 后立即推消息（claude 启动很快）
    setTimeout(() => {
      pushClaudeLine(stdout, {
        type: 'system',
        subtype: 'init',
        session_id: 'claude-sess-1',
      })
      pushClaudeLine(stdout, {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
        },
      })
      pushClaudeLine(stdout, {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'hello',
      })
    }, 10)

    const events: unknown[] = []
    for await (const e of adapter.startTurn({ sessionId: 'sess-1', prompt: 'hi' })) {
      events.push(e)
    }

    expect(events.some((e: any) => e.type === 'turn_started')).toBe(true)
    expect(events.some((e: any) => e.type === 'text_delta' && e.text === 'hello')).toBe(true)
    expect(events.some((e: any) => e.type === 'turn_completed' && e.status === 'completed')).toBe(true)
  })

  test('tool_use + tool_result 流程', async () => {
    const { spawner, stdout } = createMockSpawner()
    const adapter = new ClaudeAdapter({ spawner })

    setTimeout(() => {
      pushClaudeLine(stdout, { type: 'system', subtype: 'init', session_id: 's1' })
      // assistant: tool_use
      pushClaudeLine(stdout, {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'Bash',
              input: { command: 'ls' },
            },
          ],
        },
      })
      // user: tool_result
      pushClaudeLine(stdout, {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: 'file1\nfile2',
            },
          ],
        },
      })
      // assistant: 最终回复
      pushClaudeLine(stdout, {
        type: 'assistant',
        message: {
          id: 'm2',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        },
      })
      pushClaudeLine(stdout, {
        type: 'result',
        subtype: 'success',
        is_error: false,
      })
    }, 10)

    const events: unknown[] = []
    for await (const e of adapter.startTurn({ sessionId: 'sess-1', prompt: 'list files' })) {
      events.push(e)
    }

    expect(events.some((e: any) => e.type === 'tool_call_started' && e.tool.kind === 'shell_command')).toBe(true)
    expect(events.some((e: any) => e.type === 'tool_call_completed' && e.output.ok === true)).toBe(true)
    expect(events.some((e: any) => e.type === 'turn_completed')).toBe(true)
  })

  test('result error → turn_completed status=error', async () => {
    const { spawner, stdout } = createMockSpawner()
    const adapter = new ClaudeAdapter({ spawner })

    setTimeout(() => {
      pushClaudeLine(stdout, { type: 'system', subtype: 'init', session_id: 's1' })
      pushClaudeLine(stdout, {
        type: 'result',
        subtype: 'error_max_budget_usd',
        is_error: true,
        errors: ['budget exceeded'],
      })
    }, 10)

    const events: unknown[] = []
    for await (const e of adapter.startTurn({ sessionId: 'sess-1', prompt: 'hi' })) {
      events.push(e)
    }

    expect(events.some((e: any) => e.type === 'turn_completed' && e.status === 'error')).toBe(true)
  })

  test('capabilities: 不支持 approval/steer/fork', () => {
    const adapter = new ClaudeAdapter()
    expect(adapter.capabilities.supportsApproval).toBe(false)
    expect(adapter.capabilities.supportsSteer).toBe(false)
    expect(adapter.capabilities.supportsThreadFork).toBe(false)
    expect(adapter.capabilities.supportedEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  test('listModels 返回固定列表', async () => {
    const adapter = new ClaudeAdapter()
    const models = await adapter.listModels()
    expect(models.length).toBeGreaterThanOrEqual(2)
    expect(models.some((m) => m.isDefault)).toBe(true)
  })
})
```

### Step 4: 测试 + commit

```bash
pnpm test tests/backend/claude-adapter.test.ts
pnpm typecheck && pnpm lint
git add src/main/backend/claude/ tests/backend/claude-adapter.test.ts
git commit -m "feat(backend): implement ClaudeAdapter with stream-json protocol"
```

---

## Task 4: claude-resolver + BackendManager 注册 Claude

**Files:**
- Create: `src/main/service/claude-resolver.ts`
- Modify: `src/main/backend/manager.ts`（注册 ClaudeAdapter）

### Step 1: 创建 claude-resolver.ts

Create `src/main/service/claude-resolver.ts`：

```ts
/**
 * 解析 claude CLI 路径。和 codex-resolver 结构相同。
 */
import { existsSync } from 'node:fs'
import { logger } from './logger'

const log = logger.domain('claude-resolver')

export async function resolveClaudePath(customPath?: string | null): Promise<string | null> {
  if (customPath && existsSync(customPath)) {
    log.info('using custom path:', customPath)
    return customPath
  }

  try {
    const { execSync } = await import('node:child_process')
    const path = execSync('which claude', { encoding: 'utf-8', timeout: 3000 }).trim()
    if (path && existsSync(path)) {
      log.info('found in PATH:', path)
      return path
    }
  } catch {
    // not in PATH
  }

  log.warn('claude not found')
  return null
}
```

### Step 2: 修改 BackendManager 注册 Claude

**Modify** `src/main/backend/manager.ts` —— 找到 `this.adapters.set('codex', new CodexAdapter())` 那行（构造函数里），替换为：

```ts
    this.adapters.set('codex', new CodexAdapter())
    this.adapters.set('claude', new ClaudeAdapter())
```

并在文件顶部加 import：

```ts
import { ClaudeAdapter } from './claude/adapter'
```

（放在已有的 `import { CodexAdapter } from './codex/adapter'` 之后）

### Step 3: typecheck + commit

```bash
pnpm typecheck && pnpm lint
git add src/main/service/claude-resolver.ts src/main/backend/manager.ts
git commit -m "feat(backend): register ClaudeAdapter in BackendManager"
```

---

## Task 5: session store + ChatView 改为两栏布局

**Files:**
- Modify: `src/renderer/src/stores/session.ts`（加 reconcile、setCurrent、createWithBackend）
- Modify: `src/renderer/src/views/ChatView.vue`（Sidebar + MainContent 布局）
- Modify: `src/renderer/src/stores/backend.ts`（暴露 capabilities 给 UI）
- Create: `src/renderer/src/components/sidebar/Sidebar.vue`
- Create: `src/renderer/src/components/sidebar/WorkspaceSwitcher.vue`
- Create: `src/renderer/src/components/sidebar/SessionList.vue`
- Create: `src/renderer/src/components/sidebar/SessionItem.vue`
- Create: `src/renderer/src/components/sidebar/BackendIndicator.vue`

### Step 1: 修改 session store 加 reconcile + 切换后端刷新

**Modify** `src/renderer/src/stores/session.ts` —— 替换整个文件：

```ts
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { SessionView } from '@shared/domain'

export const useSessionStore = defineStore('session', () => {
  const sessions = ref<SessionView[]>([])
  const currentSessionId = ref<string | null>(null)
  const loading = ref(false)

  const currentSession = computed(() =>
    sessions.value.find((s) => s.id === currentSessionId.value),
  )

  /** 按 backend 分组（当前后端 = continuable，其他 = readonly） */
  const sessionsByBackend = computed(() => {
    const continuable: SessionView[] = []
    const readonly: SessionView[] = []
    for (const s of sessions.value) {
      if (s.continuable) continuable.push(s)
      else readonly.push(s)
    }
    return { continuable, readonly }
  })

  async function load(workspaceId: string): Promise<void> {
    loading.value = true
    try {
      sessions.value = await window.api.session.list({ workspaceId })
    } finally {
      loading.value = false
    }
  }

  /** 与后端对账（启动时、切工作区时、切后端时调） */
  async function reconcile(workspaceId: string): Promise<void> {
    const { added, removed } = await window.api.session.reconcile({ workspaceId })
    if (added.length > 0 || removed.length > 0) {
      await load(workspaceId)
    }
  }

  async function create(args: {
    workspaceId: string
    cwd: string
    backend?: import('@shared/constants').BackendId
    model?: string
    effort?: import('@shared/backend/types').EffortLevel
    permissionMode?: import('@shared/backend/types').PermissionMode
    initialPrompt?: string
  }): Promise<string> {
    const { sessionId } = await window.api.session.create(args)
    await load(args.workspaceId)
    return sessionId
  }

  async function remove(sessionId: string): Promise<void> {
    await window.api.session.remove({ sessionId })
    sessions.value = sessions.value.filter((s) => s.id !== sessionId)
    if (currentSessionId.value === sessionId) {
      currentSessionId.value = null
    }
  }

  function setCurrent(sessionId: string): void {
    currentSessionId.value = sessionId
  }

  return {
    sessions,
    currentSessionId,
    loading,
    currentSession,
    sessionsByBackend,
    load,
    reconcile,
    create,
    remove,
    setCurrent,
  }
})
```

### Step 2: 修改 backend store 加 currentBackendId watch

**Modify** `src/renderer/src/stores/backend.ts` —— `switchTo` 后 session 列表的 continuable 标记需要刷新。

在 `switchTo` 函数末尾追加（在 `await loadModels()` 之后）：

```ts
  async function switchTo(id: BackendId): Promise<void> {
    await window.api.backend.switch({ id })
    currentId.value = id
    await loadModels()
    // 通知 session store 刷新 continuable 标记
    // 实际实现：session store 监听 backend.currentId 变化重新加载
  }
```

由于 continuable 是计算属性（基于 session.backend === currentBackend），切后端后 UI 自动重算即可，不用主动刷新。**这一步不改 backend.ts，session store 的 sessionsByBackend 会自动响应**。

### Step 3: 创建 Sidebar 组件

Create `src/renderer/src/components/sidebar/Sidebar.vue`：

```vue
<template>
  <aside class="w-60 flex flex-col bg-sidebar-background border-r border-sidebar-border">
    <!-- 顶部：工作区切换 -->
    <WorkspaceSwitcher />

    <!-- 中部：会话列表 -->
    <SessionList class="flex-1 overflow-y-auto" />

    <!-- 底部：后端状态 -->
    <BackendIndicator />
  </aside>
</template>

<script setup lang="ts">
import WorkspaceSwitcher from './WorkspaceSwitcher.vue'
import SessionList from './SessionList.vue'
import BackendIndicator from './BackendIndicator.vue'
</script>
```

### Step 4: 创建 WorkspaceSwitcher

Create `src/renderer/src/components/sidebar/WorkspaceSwitcher.vue`：

```vue
<template>
  <div class="p-2 border-b border-sidebar-border">
    <button
      class="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted text-left"
      @click="showPicker = !showPicker"
    >
      <FolderIcon class="w-4 h-4 flex-shrink-0 text-muted-foreground" />
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium text-foreground truncate">
          {{ workspaceStore.currentWorkspace?.name ?? '选择工作区' }}
        </div>
        <div v-if="workspaceStore.currentWorkspace" class="text-xs text-muted-foreground truncate font-mono">
          {{ workspaceStore.currentWorkspace.path }}
        </div>
      </div>
      <ChevronDownIcon class="w-4 h-4 text-muted-foreground" />
    </button>

    <!-- 工作区列表（简单弹层，不用 shadcn dropdown） -->
    <div
      v-if="showPicker"
      class="absolute z-50 mt-1 w-56 rounded-md border border-border bg-popover shadow-lg"
    >
      <button
        v-for="ws in workspaceStore.workspaces"
        :key="ws.id"
        class="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted text-left"
        @click="selectWorkspace(ws.id)"
      >
        <FolderIcon class="w-4 h-4 flex-shrink-0 text-muted-foreground" />
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium truncate">{{ ws.name }}</div>
          <div class="text-xs text-muted-foreground truncate font-mono">{{ ws.path }}</div>
        </div>
      </button>
      <button
        class="w-full flex items-center gap-2 px-3 py-2 border-t border-border hover:bg-muted text-left text-sm"
        @click="addWorkspace"
      >
        <PlusIcon class="w-4 h-4" />
        <span>添加工作区</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { FolderIcon, ChevronDownIcon, PlusIcon } from 'lucide-vue-next'
import { useWorkspaceStore } from '@renderer/stores/workspace'

const router = useRouter()
const workspaceStore = useWorkspaceStore()
const showPicker = ref(false)

onMounted(async () => {
  await workspaceStore.load()
})

async function selectWorkspace(id: string): Promise<void> {
  workspaceStore.setCurrent(id)
  showPicker.value = false
  // 重新加载该工作区的 sessions
  if (workspaceStore.currentWorkspace) {
    const { useSessionStore } = await import('@renderer/stores/session')
    const sessionStore = useSessionStore()
    await sessionStore.load(workspaceStore.currentWorkspace.id)
  }
}

async function addWorkspace(): Promise<void> {
  const result = await window.api.system.openDialog({
    title: '选择工作区文件夹',
    properties: ['openDirectory'],
  })
  if (!result.canceled && result.filePaths.length > 0) {
    await workspaceStore.add(result.filePaths[0]!)
    showPicker.value = false
  }
}
</script>
```

### Step 5: 创建 SessionList（按后端分区）

Create `src/renderer/src/components/sidebar/SessionList.vue`：

```vue
<template>
  <div class="p-2">
    <!-- 当前工作区不存在时 -->
    <div v-if="!workspaceStore.currentWorkspace" class="text-center text-xs text-muted-foreground py-8">
      请先选择工作区
    </div>

    <template v-else>
      <!-- 可继续区 -->
      <div v-if="sessionsByBackend.continuable.length > 0" class="mb-4">
        <div class="text-xs font-medium text-muted-foreground px-2 mb-1 uppercase tracking-wide">
          {{ backendStore.currentId }} · 可继续
        </div>
        <SessionItem
          v-for="session in sessionsByBackend.continuable"
          :key="session.id"
          :session="session"
          :active="session.id === sessionStore.currentSessionId"
          @click="selectSession(session.id)"
          @remove="removeSession(session.id)"
        />
      </div>

      <!-- 其他后端只读区 -->
      <details v-if="sessionsByBackend.readonly.length > 0" class="mb-2">
        <summary class="text-xs font-medium text-muted-foreground px-2 py-1 cursor-pointer hover:text-foreground">
          其他后端 · 只读 ({{ sessionsByBackend.readonly.length }})
        </summary>
        <SessionItem
          v-for="session in sessionsByBackend.readonly"
          :key="session.id"
          :session="session"
          :active="session.id === sessionStore.currentSessionId"
          readonly
          @click="selectSession(session.id)"
          @remove="removeSession(session.id)"
        />
      </details>

      <!-- 新建会话按钮 -->
      <button
        class="w-full mt-2 px-3 py-2 text-sm text-primary hover:bg-muted rounded-md flex items-center gap-2"
        @click="newSession"
      >
        <PlusIcon class="w-4 h-4" />
        新建会话
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { PlusIcon } from 'lucide-vue-next'
import SessionItem from './SessionItem.vue'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { useSessionStore } from '@renderer/stores/session'
import { useBackendStore } from '@renderer/stores/backend'
import { useMessageStore } from '@renderer/stores/message'

const workspaceStore = useWorkspaceStore()
const sessionStore = useSessionStore()
const backendStore = useBackendStore()
const messageStore = useMessageStore()

const sessionsByBackend = computed(() => sessionStore.sessionsByBackend)

onMounted(async () => {
  if (workspaceStore.currentWorkspace) {
    await sessionStore.load(workspaceStore.currentWorkspace.id)
    await sessionStore.reconcile(workspaceStore.currentWorkspace.id)
  }
})

// 切工作区时重新加载
watch(
  () => workspaceStore.currentWorkspace?.id,
  async (id) => {
    if (id) {
      await sessionStore.load(id)
      await sessionStore.reconcile(id)
    }
  },
)

async function selectSession(id: string): Promise<void> {
  sessionStore.setCurrent(id)
  messageStore.reset()
  // TODO Plan 4+: 加载历史消息（session.detail）
}

async function removeSession(id: string): Promise<void> {
  if (!window.confirm('删除此会话？')) return
  await sessionStore.remove(id)
}

async function newSession(): Promise<void> {
  sessionStore.setCurrent('')
  messageStore.reset()
}
</script>
```

注意 `setCurrent('')` 会让 `currentSession` 为 undefined，触发 ChatView 的"新建会话"流程。

### Step 6: 创建 SessionItem

Create `src/renderer/src/components/sidebar/SessionItem.vue`：

```vue
<template>
  <div
    :class="[
      'group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer',
      active ? 'bg-muted' : 'hover:bg-muted/50',
    ]"
    @click="$emit('click')"
  >
    <MessageSquareIcon class="w-4 h-4 flex-shrink-0 text-muted-foreground" />
    <div class="flex-1 min-w-0">
      <div class="text-sm text-foreground truncate">
        {{ session.title || '(新会话)' }}
      </div>
      <div class="text-xs text-muted-foreground flex items-center gap-1">
        <span>{{ session.backend }}</span>
        <span>·</span>
        <span>{{ formatRelativeTime(session.lastActiveAt) }}</span>
      </div>
    </div>

    <!-- 只读标记 -->
    <LockIcon v-if="readonly" class="w-3 h-3 text-muted-foreground flex-shrink-0" />

    <!-- 删除按钮（hover 显示，只读也允许删） -->
    <button
      class="opacity-0 group-hover:opacity-100 p-1 hover:text-destructive"
      @click.stop="$emit('remove')"
    >
      <Trash2Icon class="w-3 h-3" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { MessageSquareIcon, Trash2Icon, LockIcon } from 'lucide-vue-next'
import { formatRelativeTime } from '@renderer/lib/format'
import type { SessionView } from '@shared/domain'

defineProps<{
  session: SessionView
  active: boolean
  readonly?: boolean
}>()
defineEmits<{ click: []; remove: [] }>()
</script>
```

### Step 7: 创建 BackendIndicator

Create `src/renderer/src/components/sidebar/BackendIndicator.vue`：

```vue
<template>
  <div class="p-2 border-t border-sidebar-border">
    <div class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted">
      <div
        :class="[
          'w-2 h-2 rounded-full',
          backendStore.isAvailable ? 'bg-success' : 'bg-destructive',
        ]"
      />
      <select
        v-model="backendId"
        class="flex-1 bg-transparent text-sm text-foreground border-0 focus:outline-none cursor-pointer"
      >
        <option
          v-for="status in backendStore.statuses"
          :key="status.id"
          :value="status.id"
          :disabled="!status.available"
        >
          {{ status.id }}{{ status.available ? ` (${status.version})` : ' (unavailable)' }}
        </option>
      </select>
      <button
        class="text-muted-foreground hover:text-foreground"
        title="设置"
        @click="openSettings"
      >
        <SettingsIcon class="w-4 h-4" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { SettingsIcon } from 'lucide-vue-next'
import { useBackendStore } from '@renderer/stores/backend'
import type { BackendId } from '@shared/constants'

const router = useRouter()
const backendStore = useBackendStore()

const backendId = computed<BackendId>({
  get: () => backendStore.currentId,
  set: (v) => {
    void backendStore.switchTo(v)
  },
})

function openSettings(): void {
  router.push('/settings')
}
</script>
```

### Step 8: 修改 ChatView 改为两栏布局

**Modify** `src/renderer/src/views/ChatView.vue` —— 在最外层 template 改为 Sidebar + 主区。把 `<template>` 根元素替换：

找到现有的 `<template>` 根 div（class `h-full flex flex-col`），改为：

```vue
<template>
  <div class="h-full flex">
    <!-- 侧边栏 -->
    <Sidebar />

    <!-- 主聊天区 -->
    <div class="flex-1 flex flex-col min-w-0">
      <RuntimeConfigBar
        :model-value="runtimeConfig"
        @update:model-value="runtimeConfig = $event"
      />

      <MessageList v-if="messageStore.messages.length > 0" class="flex-1" />
      <div v-else class="flex-1 flex items-center justify-center text-muted-foreground">
        <div class="text-center">
          <p class="text-lg font-medium text-foreground">开始新对话</p>
          <p class="text-sm mt-2">
            在工作区 {{ workspaceStore.currentWorkspace?.name }} 里发条消息
          </p>
          <p class="text-xs mt-1">使用 {{ backendStore.currentId }} 后端</p>
        </div>
      </div>

      <ApprovalDialog v-if="messageStore.pendingApproval" />

      <Composer :disabled="!backendStore.isAvailable" @send="onSend" />
    </div>
  </div>
</template>
```

在 `<script setup>` 里加 Sidebar import：

```ts
import Sidebar from '@renderer/components/sidebar/Sidebar.vue'
```

### Step 9: typecheck + lint + commit

```bash
pnpm typecheck && pnpm lint
git add src/renderer/src/stores/session.ts src/renderer/src/components/sidebar/ src/renderer/src/views/ChatView.vue
git commit -m "feat(sidebar): add full sidebar with workspace switcher, session list (by backend), backend indicator"
```

---

## Task 6: 集成验证 + smoke test

**Files:**
- Run: 全套测试 + typecheck + lint + dev 启动
- Create: `docs/superpowers/plans/2026-07-18-plan-3-smoke-test.md`

### Step 1: 全套自动化测试

```bash
pnpm rebuild:node
pnpm typecheck
pnpm lint
pnpm test
```

Expected:
- typecheck 0 errors
- lint 0 errors
- 全部测试通过（103 + Plan 3 新增，预计 120+ tests）

### Step 2: production build

```bash
pnpm rebuild:native
pnpm build
```

### Step 3: dev 启动 + 端到端走查

```bash
pnpm dev
```

可视化验证（需要 codex + claude CLI 都装好）：

1. ✅ 启动看到侧边栏 + 主区两栏布局
2. ✅ WorkspaceSwitcher 可切换工作区、添加工作区
3. ✅ SessionList 显示会话，按后端分区
4. ✅ BackendIndicator 显示后端 + 状态点（绿/红）
5. ✅ 在 BackendIndicator 切换 codex ↔ claude
6. ✅ 切换后 session 列表的 continuable/readonly 自动重算
7. ✅ 用 codex 跑一个 turn
8. ✅ 切到 claude，跑一个 turn
9. ✅ 旧 codex 会话显示在"其他后端只读"区
10. ✅ 点只读会话能浏览（MVP：消息列表为空，但能切换上下文）
11. ✅ 删除会话（confirm 后真删）

### Step 4: 写 smoke test 文档

Create `docs/superpowers/plans/2026-07-18-plan-3-smoke-test.md`：

```markdown
# Plan 3 Smoke Test 端到端验证清单

## 自动化验证（已通过）

- [ ] `pnpm typecheck` 0 errors
- [ ] `pnpm lint` 0 errors
- [ ] `pnpm test` 全部通过（预计 120+ tests）
- [ ] `pnpm build` production 成功

## 可视化验证（需要 codex + claude CLI）

### 启动 + 布局
- [ ] 启动看到 Sidebar + 主区两栏
- [ ] Sidebar 240px 宽，主区占剩余

### 工作区切换
- [ ] WorkspaceSwitcher 显示当前工作区
- [ ] 点击展开工作区列表
- [ ] 切换工作区 → session 列表刷新
- [ ] 添加工作区 → 弹文件夹选择器

### 会话列表（按后端分区）
- [ ] 当前后端的会话在"可继续"区
- [ ] 其他后端的会话在"只读"区（折叠）
- [ ] 点击会话切换 currentSession
- [ ] hover 显示删除按钮
- [ ] 删除会话弹 confirm

### 后端切换
- [ ] BackendIndicator 显示后端名 + 版本 + 状态点
- [ ] 切换 codex ↔ claude
- [ ] 切换后会话列表的 continuable/readonly 自动重算

### 双后端真实聊天
- [ ] codex 跑一个 turn（流式输出 + tool call）
- [ ] 切到 claude，跑一个 turn
- [ ] 两个后端的 capabilities 不同（claude 没 approval，UI 不显示 approval 弹窗）

### 持久化
- [ ] 关闭重启后工作区、会话都保留
- [ ] 会话归属不变（codex 会话永远是 codex）

## 已知限制（Plan 4+）

- [ ] 只读会话的消息列表为空（resume 是 Plan 4+）
- [ ] 没有 ⌘K 命令面板
- [ ] 没有 Git/文件树/终端/编辑器集成

## 总结

Plan 3 完成度：X/6 tasks ✅。

核心能力交付：双后端（codex + claude）真实可切换、完整侧边栏（工作区/会话/后端）、会话按后端分区显示。
```

### Step 5: 提交

```bash
git add docs/superpowers/plans/2026-07-18-plan-3-smoke-test.md
git commit -m "docs: add Plan 3 smoke test checklist"
```

---

## Plan 3 完成标志

完成后应该有：
- ✅ `ClaudeAdapter` 完整实现（stream-json 协议、tool_use/tool_result 流程、中断 = kill）
- ✅ `BackendManager` 注册两个 adapter（codex + claude）
- ✅ 完整侧边栏：WorkspaceSwitcher + SessionList（按后端分区）+ BackendIndicator
- ✅ ChatView 改为 Sidebar + MainContent 两栏布局
- ✅ 会话按后端分区显示（"可继续" vs "其他后端只读"）
- ✅ 切换后端后会话 continuable 标记自动重算
- ✅ 全套测试通过（120+ tests）
- ✅ 真实双后端端到端验证

**下一阶段（Plan 4）**：Plan 1 没做完的周边功能（Git 面板、文件树、终端、编辑器集成、⌘K 命令面板）。

---

## 自检（writing-plans skill 要求）

**1. Spec 覆盖**：

Plan 3 覆盖：
- ✅ Phase 7 剩余（Claude adapter）—— Task 1-4
- ✅ Phase 8 部分（侧边栏 + 会话管理 + 后端切换）—— Task 5

**剩余 Phase 8-10**（Git/文件树/终端/编辑器/⌘K）留给 Plan 4。

**2. 占位符扫描**：

已检查——所有 Task 含完整代码。`session.detail` 返回空数组是 MVP 简化（Plan 4+ 实现 codex/claude 的 rollout 回放）。

**3. 类型一致性**：

- `BackendId` 增加 `'claude'` 后，原 `'codex'` 不变
- `ClaudeAdapter.capabilities` 和 CodexAdapter 不同（approval/steer/fork 都 false）
- `TurnEvent` 联合类型对两个后端完全一致（UI 不需要区分）
- `SessionView.continuable` 字段在 session store 的 computed 里基于 backend === currentBackend 自动算

**4. 已知简化**：

- ClaudeAdapter 不支持 approval（permission-mode 自动决策）
- ClaudeAdapter 不支持 steer（一次 turn 一个进程，无法"中途补充"）
- `session.detail` 返回空 messages（Plan 4+）
- BackendManager `listSessions` 对 claude 返回空（claude 不像 codex 那样有 thread/list API）
