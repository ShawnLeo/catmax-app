# Plan 5: 会话历史回放 + 打包发布 + 快捷键体系 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 MVP 之后用户最需要的三个体验短板：(1) **会话历史回放** —— 点击侧边栏会话立即看到完整历史对话（含 tool call）；(2) **打包发布** —— 一键产出 macOS dmg + Windows exe；(3) **快捷键体系** —— 在已有 ⌘K 框架上扩展完整的快捷键（⌘N 新建会话、⌘W 关闭、⌘1-9 切换会话等）。

**Architecture:**
- **会话回放** —— 在 Adapter 层加 `getHistory(backendThreadId): Promise<NormalizedMessage[]>`。CodexAdapter 调 `thread/read`（带 `includeTurns: true`）拿到 turn 数组，复用 Plan 4 已有的 mapping（codexItemToToolCallInfo 等）转成 NormalizedMessage。ClaudeAdapter 用 `--resume <id>` 启动一个临时进程，stdout 收到 `result` 消息后 kill 进程，把重放的 assistant/user 消息转成 NormalizedMessage。
- **打包发布** —— 添加 `electron-builder.yml` + `package.json` 的 `dist` script。复用 Plan 1 的 `electron-updater` 依赖（暂不接入自动更新，留作后续）。
- **快捷键** —— 扩展 `useShortcut` composable（Plan 4b 已有），通过 `commandRegistry.register({ shortcut: 'mod+n' })` 注册命令时一并绑定快捷键。

**Tech Stack:** （全部已就位，无新依赖）Electron 31 + Vue 3 + electron-builder + electron-updater。

**设计文档参考：** `docs/superpowers/specs/2026-07-18-catmax-app-design.md`（路线图）
**协议参考：** [codex thread/read](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

---

## 关键设计决策

### 决策 1：codex 历史回放用 `thread/read`（不是 `thread/resume`）

`thread/resume` 会**订阅事件流**（会触发后续 turn 的推送），不适合纯读场景。`thread/read` 是只读 API，专门用于读取历史。返回的 `thread.turns` 含完整 items 数组。

### 决策 2：claude 历史回放是"伪只读"

claude 没有 `thread/read` API，只能用 `--resume <id>` 启动一个进程。**关键**：启动后**不写 stdin**（不发新 user 消息），claude 会自动重放历史 user/assistant 消息到 stdout，最后发出 `result` 通知（subtype=success），此时 kill 进程。

### 决策 3：历史只显示"已完成"的内容

历史回放**不恢复**流式状态（如某个 tool_call 还在 running），全部按 completed 渲染。如果某个 turn 当年是被中断的，status 显示 interrupted，但不显示"running"动画。

### 决策 4：打包不发 notarize（自用项目）

`electron-builder.yml` 的 mac 配置**不开** notarize（需要 Apple Developer 账号）。用户首次打开 macOS dmg 会看到"未签名"警告，右键打开即可。

### 决策 5：快捷键随命令注册

不在命令系统外维护单独的快捷键表。`commandRegistry.register({ id, shortcut })` 时，如果传了 `shortcut`，自动绑定全局 keydown 监听。

---

## 文件结构

```
catmax-app/
├─ electron-builder.yml                       # 🆕 打包配置
├─ package.json                               # 📝 加 dist script + build 元数据
├─ src/
│  ├─ shared/
│  │  └─ backend/
│  │     └─ types.ts                          # 📝 AgentBackend 加 getHistory 方法
│  │
│  ├─ main/
│  │  ├─ backend/
│  │  │  ├─ codex/
│  │  │  │  ├─ adapter.ts                     # 📝 实现 getHistory（调 thread/read）
│  │  │  │  └─ history-mapping.ts             # 🆕 codex turn/items → NormalizedMessage[]
│  │  │  ├─ claude/
│  │  │  │  ├─ adapter.ts                     # 📝 实现 getHistory（spawn --resume）
│  │  │  │  └─ history-mapping.ts             # 🆕 claude 重放消息 → NormalizedMessage[]
│  │  │  └─ manager.ts                        # 📝 暴露 getHistory 给 IPC
│  │  └─ ipc/
│  │     └─ domains/
│  │        └─ session/
│  │           └── handlers.ts                # 📝 getSessionDetail 真实实现（用 session.backend 选 adapter）
│  │
│  └─ renderer/src/
│     ├─ components/
│     │  ├─ sidebar/
│     │  │  └─ SessionList.vue                # 📝 点击会话时调 detail 加载历史
│     │  └─ chat/
│     │     └─ MessageList.vue                # 📝 加"加载历史中"loading 态
│     ├─ stores/
│     │  └─ session.ts                        # 📝 加 loadHistory 方法
│     └─ lib/
│        ├── commands.ts                      # 📝 注册更多命令 + 快捷键
│        └── commandRegistry.ts               # 📝 shortcut 自动绑定
│
└─ tests/
   └─ backend/
      ├─ codex-history-mapping.test.ts        # 🆕
      └─ claude-history-mapping.test.ts       # 🆕
```

---

## Task 1: AgentBackend 接口加 getHistory + codex history mapping

**Files:**
- Modify: `src/shared/backend/types.ts`（加 `getHistory` 方法到 AgentBackend 接口）
- Create: `src/main/backend/codex/history-mapping.ts`
- Test: `tests/backend/codex-history-mapping.test.ts`

### Step 1: 修改 AgentBackend 接口

**Modify** `src/shared/backend/types.ts` —— 在 `AgentBackend` 接口的 `resumeSession` 方法后追加：

```ts
  /** 读取会话历史（用于 UI 回放，不影响后端状态） */
  getHistory(backendThreadId: string): Promise<{ messages: NormalizedMessage[] }>
```

注意：`resumeSession` 已经存在但返回 `{ messages: never[] }`（Plan 2 占位）。**不删** resumeSession（保持兼容），但加一个新的 `getHistory` 方法语义更清晰。

### Step 2: 创建 codex history-mapping.ts

Create `src/main/backend/codex/history-mapping.ts`：

```ts
/**
 * codex thread/read 返回的 turn/items → NormalizedMessage[]
 *
 * codex 的历史结构：
 *   thread.turns: Turn[]
 *     turn.items: Item[]（user_message / agent_message / command_execution / file_change / ...）
 *
 * 转换规则：
 *   - user_message → role: 'user', textBlocks
 *   - agent_message → role: 'assistant', textBlocks
 *   - command_execution / file_change / mcp_tool_call → 归到上一个 assistant message 的 toolBlocks
 *   - reasoning → 归到上一个 assistant message 的 textBlocks（kind: 'reasoning'）
 */
import type { CodexItem } from '@shared/backend/schema'
import type { NormalizedMessage } from '@shared/backend/types'
import { codexCommandToOutput, codexFileChangeToOutput, codexItemToToolCallInfo } from './mapping'
import { randomUUID } from 'node:crypto'

/** 从 thread.read 响应提取 turn 数组 */
export function extractTurns(readResult: unknown): unknown[] {
  const thread = (readResult as { thread?: { turns?: unknown[] } }).thread
  return thread?.turns ?? []
}

/** 从 turn 提取 items */
export function extractItems(turn: unknown): CodexItem[] {
  const items = (turn as { items?: unknown[] }).items ?? []
  // 用 codexItemSchema 校验每个 item（不合法的跳过）
  return items.filter((item): item is CodexItem => {
    return typeof item === 'object' && item !== null && 'type' in item && 'id' in item
  })
}

/** 把多个 turn 的 items 展平 + 转成 NormalizedMessage[] */
export function codexTurnsToMessages(turns: unknown[]): NormalizedMessage[] {
  const messages: NormalizedMessage[] = []
  let currentAssistant: NormalizedMessage | null = null
  let currentTurnId = 'history-unknown'

  for (const turn of turns) {
    const turnId = (turn as { id?: string })?.id ?? randomUUID()
    currentTurnId = turnId
    const items = extractItems(turn)

    for (const item of items) {
      const msg = mapItemToMessage(item, currentTurnId)
      if (!msg) continue

      if (msg.role === 'assistant') {
        // 新 assistant message
        if (currentAssistant) messages.push(currentAssistant)
        currentAssistant = msg
      } else if (msg.role === 'user') {
        // user message：先 flush 之前的 assistant
        if (currentAssistant) {
          messages.push(currentAssistant)
          currentAssistant = null
        }
        messages.push(msg)
      }
    }
  }
  // flush 最后一个
  if (currentAssistant) messages.push(currentAssistant)

  return messages
}

/** 单个 codex item → NormalizedMessage（或 null 跳过） */
function mapItemToMessage(item: CodexItem, turnId: string): NormalizedMessage | null {
  const itemId = item.id

  switch (item.type) {
    case 'user_message': {
      const content = (item as { content?: unknown[] }).content
      const text = extractUserText(content)
      if (!text) return null
      return {
        id: itemId,
        role: 'user',
        turnId,
        textBlocks: [{ id: `${itemId}-text`, text, kind: 'text' }],
        createdAt: 0, // codex 不在 item 里返回 createdAt，UI 用 turns 的时间
      }
    }
    case 'agent_message': {
      const text = (item as { text?: string }).text ?? ''
      return {
        id: itemId,
        role: 'assistant',
        turnId,
        textBlocks: text ? [{ id: `${itemId}-text`, text, kind: 'text' }] : [],
        toolBlocks: [],
        createdAt: 0,
      }
    }
    case 'reasoning': {
      // reasoning 不单独成 message，会被合并到上一个 assistant
      // 这里返回一个特殊的 assistant message，让上游合并
      const summary = extractReasoningSummary((item as { summary?: unknown[] }).summary)
      return {
        id: itemId,
        role: 'assistant',
        turnId,
        textBlocks: summary ? [{ id: `${itemId}-reasoning`, text: summary, kind: 'reasoning' }] : [],
        toolBlocks: [],
        createdAt: 0,
      }
    }
    case 'command_execution':
    case 'file_change':
    case 'mcp_tool_call': {
      // tool call 不单独成 message，合并到上一个 assistant 的 toolBlocks
      // 返回 null 表示"不新建 message"，但调用方需要单独处理
      // 简化：直接返回一个 role='tool' 的 message
      const toolInfo = codexItemToToolCallInfo(item)
      if (!toolInfo) return null
      let output: import('@shared/backend/types').ToolOutput | undefined
      if (item.type === 'command_execution') {
        output = codexCommandToOutput(item as Parameters<typeof codexCommandToOutput>[0])
      } else if (item.type === 'file_change') {
        output = codexFileChangeToOutput(item as Parameters<typeof codexFileChangeToOutput>[0])
      }
      return {
        id: itemId,
        role: 'tool',
        turnId,
        textBlocks: [],
        toolBlocks: [
          {
            id: itemId,
            info: toolInfo,
            status: output?.ok === false ? 'failed' : 'completed',
            output,
          },
        ],
        createdAt: 0,
      }
    }
    default:
      return null
  }
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (typeof block === 'object' && block !== null && 'text' in block) {
        return String((block as { text: unknown }).text)
      }
      return ''
    })
    .join('\n')
    .trim()
}

function extractReasoningSummary(summary: unknown): string {
  if (typeof summary === 'string') return summary
  if (!Array.isArray(summary)) return ''
  return summary
    .map((s) => {
      if (typeof s === 'string') return s
      if (typeof s === 'object' && s !== null && 'text' in s) {
        return String((s as { text: unknown }).text)
      }
      return ''
    })
    .join('\n')
    .trim()
}

/** 合并相邻的 assistant + tool 消息（让 tool_blocks 归属 assistant message） */
export function mergeAssistantAndToolMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
  const result: NormalizedMessage[] = []
  for (const msg of messages) {
    if (msg.role === 'tool' && result.length > 0) {
      const last = result[result.length - 1]!
      if (last.role === 'assistant') {
        // 合并到上一个 assistant
        if (!last.toolBlocks) last.toolBlocks = []
        last.toolBlocks.push(...(msg.toolBlocks ?? []))
        continue
      }
    }
    result.push(msg)
  }
  return result
}
```

### Step 3: 写 codex history-mapping 单测

Create `tests/backend/codex-history-mapping.test.ts`：

```ts
import { describe, expect, test } from 'vitest'
import { codexTurnsToMessages, mergeAssistantAndToolMessages } from '@main/backend/codex/history-mapping'

describe('codex history mapping', () => {
  test('user_message + agent_message 转 user/assistant', () => {
    const turns = [
      {
        id: 'turn_1',
        items: [
          { type: 'user_message', id: 'u1', content: [{ type: 'text', text: 'hello' }] },
          { type: 'agent_message', id: 'a1', text: 'hi there' },
        ],
      },
    ]
    const messages = codexTurnsToMessages(turns)
    expect(messages).toHaveLength(2)
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.textBlocks?.[0]?.text).toBe('hello')
    expect(messages[1]!.role).toBe('assistant')
    expect(messages[1]!.textBlocks?.[0]?.text).toBe('hi there')
  })

  test('command_execution 转为 tool message', () => {
    const turns = [
      {
        id: 'turn_1',
        items: [
          { type: 'user_message', id: 'u1', content: 'list files' },
          { type: 'agent_message', id: 'a1', text: '' },
          {
            type: 'command_execution',
            id: 'c1',
            command: 'ls',
            status: 'completed',
            exitCode: 0,
            aggregatedOutput: 'file1\nfile2',
          },
        ],
      },
    ]
    const messages = codexTurnsToMessages(turns)
    // user + assistant（空文本）+ tool
    expect(messages.some((m) => m.role === 'tool')).toBe(true)
    const tool = messages.find((m) => m.role === 'tool')!
    expect(tool.toolBlocks?.[0]?.info.kind).toBe('shell_command')
  })

  test('mergeAssistantAndToolMessages 把 tool 合并到 assistant', () => {
    const messages = [
      { id: 'u1', role: 'user', turnId: 't1', textBlocks: [], createdAt: 0 },
      { id: 'a1', role: 'assistant', turnId: 't1', textBlocks: [], toolBlocks: [], createdAt: 0 },
      {
        id: 'c1',
        role: 'tool',
        turnId: 't1',
        textBlocks: [],
        toolBlocks: [{ id: 'c1', info: { kind: 'shell_command', title: 'ls' }, status: 'completed' }],
        createdAt: 0,
      },
    ]
    const merged = mergeAssistantAndToolMessages(messages as any)
    expect(merged).toHaveLength(2) // user + assistant（含 tool）
    expect(merged[1]!.toolBlocks).toHaveLength(1)
  })

  test('空 turns 返回空数组', () => {
    expect(codexTurnsToMessages([])).toEqual([])
  })

  test('未知 item 类型跳过', () => {
    const turns = [
      {
        id: 't1',
        items: [
          { type: 'unknown_future_type', id: 'x1', customField: 'whatever' },
          { type: 'agent_message', id: 'a1', text: 'kept' },
        ],
      },
    ]
    const messages = codexTurnsToMessages(turns)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.textBlocks?.[0]?.text).toBe('kept')
  })
})
```

### Step 4: 测试 + commit

```bash
pnpm rebuild:node
pnpm test tests/backend/codex-history-mapping.test.ts
pnpm typecheck && pnpm lint
git add src/shared/backend/types.ts src/main/backend/codex/history-mapping.ts tests/backend/codex-history-mapping.test.ts
git commit -m "feat(backend): add codex history mapping (thread.read → NormalizedMessage)"
```

---

## Task 2: CodexAdapter.getHistory 实现

**Files:**
- Modify: `src/main/backend/codex/adapter.ts`（实现 getHistory）
- Modify: `tests/backend/adapter.test.ts`（加 getHistory 测试）

### Step 1: 修改 CodexAdapter 实现 getHistory

**Modify** `src/main/backend/codex/adapter.ts` —— 在 `resumeSession` 方法后追加：

```ts
  async getHistory(backendThreadId: string): Promise<{ messages: NormalizedMessage[] }> {
    await this.ensureInitialized()
    const result = await this.sendRequest('thread/read', {
      threadId: backendThreadId,
      includeTurns: true,
    })
    const turns = extractTurns(result)
    const messages = codexTurnsToMessages(turns)
    const merged = mergeAssistantAndToolMessages(messages)
    log.info('history loaded', backendThreadId, merged.length, 'messages')
    return { messages: merged }
  }
```

在文件顶部追加 import（已有 import 后面）：

```ts
import { codexTurnsToMessages, extractTurns, mergeAssistantAndToolMessages } from './history-mapping'
```

注意：`NormalizedMessage` 类型需要从 `@shared/backend/types` import（应该已经在了）。

### Step 2: 修改 adapter.test.ts 加 getHistory 测试

**Modify** `tests/backend/adapter.test.ts` —— 在最后一个 test 后追加：

```ts
test('getHistory 返回 NormalizedMessage 数组', async () => {
  const { spawner, stdout, stdin } = createMockSpawner()
  const adapter = new CodexAdapter({ spawner })

  stdin.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean)
    for (const line of lines) {
      const msg = JSON.parse(line)
      if (msg.method === 'initialize') {
        pushLine(stdout, { id: msg.id, result: { ok: true } })
      } else if (msg.method === 'thread/read' && msg.id !== undefined) {
        pushLine(stdout, {
          id: msg.id,
          result: {
            thread: {
              id: 'thr_1',
              turns: [
                {
                  id: 'turn_1',
                  items: [
                    { type: 'user_message', id: 'u1', content: [{ type: 'text', text: 'hello' }] },
                    { type: 'agent_message', id: 'a1', text: 'world' },
                  ],
                },
              ],
            },
          },
        })
      }
    }
  })

  const { messages } = await adapter.getHistory('thr_1')
  expect(messages).toHaveLength(2)
  expect(messages[0]!.role).toBe('user')
  expect(messages[1]!.role).toBe('assistant')
  expect(messages[1]!.textBlocks?.[0]?.text).toBe('world')
})
```

### Step 3: 测试 + commit

```bash
pnpm test tests/backend/adapter.test.ts
pnpm typecheck && pnpm lint
git add src/main/backend/codex/adapter.ts tests/backend/adapter.test.ts
git commit -m "feat(backend): implement CodexAdapter.getHistory via thread/read"
```

---

## Task 3: ClaudeAdapter.getHistory 实现

**Files:**
- Create: `src/main/backend/claude/history-mapping.ts`
- Modify: `src/main/backend/claude/adapter.ts`（实现 getHistory）
- Test: `tests/backend/claude-history-mapping.test.ts`

### Step 1: 创建 claude history-mapping.ts

Create `src/main/backend/claude/history-mapping.ts`：

```ts
/**
 * claude 重放消息 → NormalizedMessage[]
 *
 * claude --resume <id> 启动后，stdout 会按时间顺序重放：
 *   1. system/init（启动握手）
 *   2. 多条 assistant + user（含 tool_use / tool_result）—— 历史回放
 *   3. result（结束）
 *
 * 这里的转换复用 Plan 3 已有的 assistantToEvents / userToolResultToEvents，
 * 但不通过 TurnEvent 中转，直接构造 NormalizedMessage。
 */
import type {
  AssistantMessage,
  ClaudeStreamMessage,
} from '@shared/backend/claude-schema'
import type { NormalizedMessage } from '@shared/backend/types'
import { toolUseToInfo, toolResultToOutput } from './mapping'
import { randomUUID } from 'node:crypto'

/** 把重放的 claude 消息流转成 NormalizedMessage[] */
export function claudeReplayToMessages(messages: ClaudeStreamMessage[]): NormalizedMessage[] {
  const result: NormalizedMessage[] = []
  let currentAssistant: NormalizedMessage | null = null
  let pendingToolUseIds = new Map<string, { info: import('@shared/backend/types').ToolCallInfo; messageId: string }>()

  function flushAssistant(): void {
    if (currentAssistant) {
      result.push(currentAssistant)
      currentAssistant = null
    }
  }

  for (const msg of messages) {
    if (msg.type === 'assistant') {
      // 新 assistant message
      flushAssistant()
      const assistantMsg = msg as AssistantMessage
      currentAssistant = {
        id: assistantMsg.message.id,
        role: 'assistant',
        turnId: 'history',
        textBlocks: [],
        toolBlocks: [],
        createdAt: 0,
      }
      for (const block of assistantMsg.message.content) {
        if (block.type === 'text') {
          const text = (block as { text: string }).text
          if (text) {
            currentAssistant.textBlocks!.push({
              id: randomUUID(),
              text,
              kind: 'text',
            })
          }
        } else if (block.type === 'thinking') {
          const text = (block as { thinking: string }).thinking
          if (text) {
            currentAssistant.textBlocks!.push({
              id: randomUUID(),
              text,
              kind: 'reasoning',
            })
          }
        } else if (block.type === 'tool_use') {
          const tu = block as Parameters<typeof toolUseToInfo>[0]
          const info = toolUseToInfo(tu)
          currentAssistant.toolBlocks!.push({
            id: tu.id,
            info,
            status: 'running', // 等 tool_result 改成 completed
          })
          pendingToolUseIds.set(tu.id, { info, messageId: currentAssistant.id })
        }
      }
    } else if (msg.type === 'user') {
      // user message 可能含 tool_result
      const content = (msg.message as { content: unknown[] }).content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
          const tr = block as Parameters<typeof toolResultToOutput>[0]
          const output = toolResultToOutput(tr)
          // 找到对应的 tool_use，更新状态
          const pending = pendingToolUseIds.get(tr.tool_use_id)
          if (pending) {
            const assistantMsg = result.find((m) => m.id === pending.messageId) ?? currentAssistant
            if (assistantMsg?.toolBlocks) {
              const tb = assistantMsg.toolBlocks.find((b) => b.id === tr.tool_use_id)
              if (tb) {
                tb.status = output.ok ? 'completed' : 'failed'
                tb.output = output
              }
            }
            pendingToolUseIds.delete(tr.tool_use_id)
          }
        } else if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text') {
          // user 真实输入文本（不是 tool_result）—— 新建 user message
          flushAssistant()
          const text = (block as { text: string }).text
          result.push({
            id: randomUUID(),
            role: 'user',
            turnId: 'history',
            textBlocks: [{ id: randomUUID(), text, kind: 'text' }],
            createdAt: 0,
          })
        }
      }
    }
    // system / result 不处理
  }
  flushAssistant()

  // 把仍是 running 状态的 tool 标为 completed（历史不应该有 running）
  for (const msg of result) {
    if (msg.toolBlocks) {
      for (const tb of msg.toolBlocks) {
        if (tb.status === 'running') {
          tb.status = 'completed'
          tb.output = { ok: true, summary: '(no result recorded)' }
        }
      }
    }
  }

  return result
}
```

### Step 2: 写 claude history-mapping 单测

Create `tests/backend/claude-history-mapping.test.ts`：

```ts
import { describe, expect, test } from 'vitest'
import { claudeReplayToMessages } from '@main/backend/claude/history-mapping'

describe('claude history mapping', () => {
  test('assistant + user 文本转消息', () => {
    const messages = claudeReplayToMessages([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
        },
      },
    ])
    expect(messages).toHaveLength(2)
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.textBlocks?.[0]?.text).toBe('hi')
    expect(messages[1]!.role).toBe('assistant')
    expect(messages[1]!.textBlocks?.[0]?.text).toBe('hello')
  })

  test('tool_use + tool_result 配对', () => {
    const messages = claudeReplayToMessages([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'text', text: 'running' },
            { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu1', content: 'file1' },
          ],
        },
      },
    ])
    expect(messages).toHaveLength(1) // assistant 含 tool
    expect(messages[0]!.toolBlocks?.[0]?.status).toBe('completed')
    expect(messages[0]!.toolBlocks?.[0]?.output?.output).toBe('file1')
  })

  test('未配对的 tool_use 标为 completed（带默认 output）', () => {
    const messages = claudeReplayToMessages([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }],
        },
      },
    ])
    expect(messages[0]!.toolBlocks?.[0]?.status).toBe('completed')
    expect(messages[0]!.toolBlocks?.[0]?.output?.summary).toContain('no result')
  })

  test('thinking 块归 reasoning', () => {
    const messages = claudeReplayToMessages([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm let me think' },
            { type: 'text', text: 'answer' },
          ],
        },
      },
    ])
    expect(messages[0]!.textBlocks).toHaveLength(2)
    expect(messages[0]!.textBlocks?.[0]?.kind).toBe('reasoning')
    expect(messages[0]!.textBlocks?.[1]?.kind).toBe('text')
  })
})
```

### Step 3: 修改 ClaudeAdapter 实现 getHistory

**Modify** `src/main/backend/claude/adapter.ts` —— 在 `interrupt` 方法前追加：

```ts
  async getHistory(backendThreadId: string): Promise<{ messages: NormalizedMessage[] }> {
    const binary = this.opts.binaryPath ?? 'claude'
    // 启动 claude 进程，--resume 但不发新输入
    const proc = this.spawner.spawn({
      command: binary,
      args: [
        '-p',
        '--output-format', 'stream-json',
        '--verbose',
        '--resume', backendThreadId,
      ],
      cwd: this.opts.cwd,
    })

    const messages: ClaudeStreamMessage[] = []
    let resolveDone: () => void
    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    const lineBuffer = new LineBuffer()

    const onChunk = (chunk: Buffer) => {
      const lines = lineBuffer.push(chunk)
      for (const line of lines) {
        const msg = parseClaudeLine(line)
        if (!msg) continue
        if (msg.type === 'result') {
          // 重放结束
          resolveDone()
          return
        }
        if (msg.type === 'assistant' || msg.type === 'user') {
          messages.push(msg)
        }
      }
    }

    proc.child.stdout?.on('data', onChunk)
    proc.child.on('exit', () => resolveDone())

    // 不写 stdin（不发新 user 消息）
    proc.endInput()

    await donePromise
    try {
      proc.kill('SIGTERM')
    } catch {
      // 已退出
    }

    const normalized = claudeReplayToMessages(messages)
    log.info('history loaded', backendThreadId, normalized.length, 'messages')
    return { messages: normalized }
  }
```

文件顶部加 import：

```ts
import { claudeReplayToMessages } from './history-mapping'
import type { ClaudeStreamMessage } from '@shared/backend/claude-schema'
import type { NormalizedMessage } from '@shared/backend/types'
```

### Step 4: 测试 + commit

```bash
pnpm test tests/backend/claude-history-mapping.test.ts
pnpm typecheck && pnpm lint
git add src/main/backend/claude/history-mapping.ts src/main/backend/claude/adapter.ts tests/backend/claude-history-mapping.test.ts
git commit -m "feat(backend): implement ClaudeAdapter.getHistory via --resume replay"
```

---

## Task 4: BackendManager.getHistory + session.detail 真实实现

**Files:**
- Modify: `src/main/backend/manager.ts`（加 getHistory 方法，按 session.backend 选 adapter）
- Modify: `src/main/ipc/domains/session/handlers.ts`（getSessionDetail 真实实现）

### Step 1: 修改 BackendManager 加 getHistory

**Modify** `src/main/backend/manager.ts` —— 在 `respondApproval` 方法后追加：

```ts
  /** 读会话历史（按 session.backend 选 adapter，不是当前 backend） */
  async getHistory(
    backend: BackendId,
    backendThreadId: string,
  ): Promise<{ messages: NormalizedMessage[] }> {
    const adapter = this.adapters.get(backend)
    if (!adapter) {
      throw new BackendError('not-initialized', `unknown backend: ${backend}`)
    }
    return adapter.getHistory(backendThreadId)
  }
```

文件顶部 import 加 `NormalizedMessage`：

```ts
import type { ..., NormalizedMessage, ... } from '@shared/backend/types'
```

### Step 2: 修改 session handlers 的 getSessionDetail

**Modify** `src/main/ipc/domains/session/handlers.ts` —— 找到 `getSessionDetail`，替换整个函数：

```ts
export const getSessionDetail = async (args: { sessionId: string }) => {
  const session = ctx.db.findSessionById(args.sessionId)
  if (!session) {
    throw new SessionError('not-found', `session not found: ${args.sessionId}`)
  }
  // 用会话自己的后端拉历史（不是当前后端）
  const { messages } = await ctx.backendManager.getHistory(
    session.backend,
    session.backendThreadId,
  )
  return {
    session: toView(session),
    messages,
  }
}
```

删除原来代码里的 `// TODO Plan 3+` 注释和占位逻辑。

### Step 3: typecheck + commit

```bash
pnpm typecheck && pnpm lint
git add src/main/backend/manager.ts src/main/ipc/domains/session/handlers.ts
git commit -m "feat(session): implement real getHistory in session.detail"
```

---

## Task 5: 渲染层加载历史 + UI loading 态

**Files:**
- Modify: `src/renderer/src/stores/session.ts`（加 loadHistory 方法）
- Modify: `src/renderer/src/components/sidebar/SessionList.vue`（点击会话调 loadHistory）
- Modify: `src/renderer/src/stores/message.ts`（加 setMessages 方法 + loading 态）
- Modify: `src/renderer/src/components/chat/MessageList.vue`（loading 态显示）

### Step 1: 修改 session store 加 loadHistory

**Modify** `src/renderer/src/stores/session.ts` —— 在 `setCurrent` 后追加：

```ts
  async function loadHistory(sessionId: string): Promise<void> {
    const { useMessageStore } = await import('@renderer/stores/message')
    const messageStore = useMessageStore()
    messageStore.setLoading(true)
    try {
      const detail = await window.api.session.detail({ sessionId })
      messageStore.setMessages(detail.messages)
    } catch (e) {
      messageStore.setError(e instanceof Error ? e.message : String(e))
    } finally {
      messageStore.setLoading(false)
    }
  }
```

在 return 里加 `loadHistory`：

```ts
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
    loadHistory,  // 🆕
  }
```

### Step 2: 修改 message store 加 setMessages / setLoading / setError

**Modify** `src/renderer/src/stores/message.ts` —— 在 `reset` 方法后追加：

```ts
  function setMessages(newMessages: NormalizedMessage[]): void {
    messages.value = newMessages
  }

  function setLoading(v: boolean): void {
    loading.value = v
  }

  function setError(msg: string | null): void {
    lastError.value = msg
  }
```

在 state 区加 `loading` ref：

```ts
  const messages = ref<NormalizedMessage[]>([])
  const currentTurnId = ref<string | null>(null)
  const isRunning = ref(false)
  const pendingApproval = ref<PendingApproval | null>(null)
  const lastError = ref<string | null>(null)
  const lastUsage = ref<TokenUsage | null>(null)
  const loading = ref(false)  // 🆕 历史加载中
```

在 return 加：

```ts
  return {
    messages,
    currentTurnId,
    isRunning,
    pendingApproval,
    lastError,
    lastUsage,
    loading,  // 🆕
    applyEvent,
    pushUserMessage,
    reset,
    setMessages,  // 🆕
    setLoading,  // 🆕
    setError,  // 🆕
  }
```

### Step 3: 修改 SessionList 点击会话调 loadHistory

**Modify** `src/renderer/src/components/sidebar/SessionList.vue` —— 找到 `selectSession`：

```ts
async function selectSession(id: string): Promise<void> {
  sessionStore.setCurrent(id)
  messageStore.reset()
  // 加载历史
  await sessionStore.loadHistory(id)
}
```

（删除原来的 `// TODO Plan 4+` 注释）

### Step 4: 修改 MessageList 加 loading 态

**Modify** `src/renderer/src/components/chat/MessageList.vue` —— template 改为：

```vue
<template>
  <div ref="container" class="h-full overflow-y-auto">
    <div v-if="messageStore.loading" class="flex items-center justify-center h-full text-muted-foreground">
      <div class="text-center">
        <div class="animate-pulse text-sm">加载历史中...</div>
      </div>
    </div>
    <div v-else class="max-w-3xl mx-auto px-6 py-4 flex flex-col gap-6">
      <MessageItem
        v-for="message in messageStore.messages"
        :key="message.id"
        :message="message"
      />
    </div>
  </div>
</template>
```

### Step 5: typecheck + lint + commit

```bash
pnpm typecheck && pnpm lint
git add src/renderer/src/stores/session.ts src/renderer/src/stores/message.ts src/renderer/src/components/sidebar/SessionList.vue src/renderer/src/components/chat/MessageList.vue
git commit -m "feat(session): load history on session click with loading state"
```

---

## Task 6: 快捷键体系（扩展 commandRegistry + 注册更多命令）

**Files:**
- Modify: `src/renderer/src/lib/commandRegistry.ts`（shortcut 自动绑定）
- Modify: `src/renderer/src/lib/commands.ts`（加更多命令 + 快捷键）

### Step 1: 修改 commandRegistry 支持 shortcut 自动绑定

**Modify** `src/renderer/src/lib/commandRegistry.ts` —— 把 `register` 方法改为：

```ts
  register(cmd: Command): () => void {
    this.commands.set(cmd.id, cmd)
    // 如果声明了 shortcut，自动绑定全局 keydown
    let unbindShortcut: (() => void) | null = null
    if (cmd.shortcut) {
      unbindShortcut = this.bindShortcut(cmd.shortcut, () => void cmd.action())
    }
    return () => {
      this.commands.delete(cmd.id)
      unbindShortcut?.()
    }
  }

  /** 解析快捷键字符串（'mod+k' / 'ctrl+shift+p'）并绑定 */
  private bindShortcut(shortcut: string, callback: () => void): () => void {
    const parts = shortcut.toLowerCase().split('+')
    const wantMod = parts.includes('mod') || parts.includes('cmd') || parts.includes('ctrl')
    const wantShift = parts.includes('shift')
    const wantAlt = parts.includes('alt')
    const key = parts[parts.length - 1]!

    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey
      if (wantMod !== isMod) return
      if (wantShift !== e.shiftKey) return
      if (wantAlt !== e.altKey) return
      if (e.key.toLowerCase() !== key) return
      e.preventDefault()
      callback()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }
```

### Step 2: 修改 commands.ts 加更多命令 + 快捷键

**Modify** `src/renderer/src/lib/commands.ts` —— 在已有的 `registerDefaultCommands` 函数里，给现有命令加 shortcut 字段，并追加新命令：

```ts
  commandRegistry.register({
    id: 'app.go-settings',
    title: '打开设置',
    category: 'Navigation',
    keywords: ['settings', 'preference', 'config'],
    shortcut: 'mod+,',  // 🆕
    action: () => void router.push('/settings'),
  })

  // ... 现有命令 ...

  // 🆕 追加新命令
  commandRegistry.register({
    id: 'session.new',
    title: '新建会话',
    category: 'Session',
    keywords: ['session', 'new', 'chat'],
    shortcut: 'mod+n',
    action: () => {
      const s = useSessionStore()
      s.setCurrent('')
      void router.push('/chat')
    },
  })

  commandRegistry.register({
    id: 'app.toggle-sidebar',
    title: '切换侧边栏',
    category: 'View',
    keywords: ['sidebar', 'toggle', 'hide'],
    shortcut: 'mod+b',
    action: () => {
      const u = useUiStore()
      u.toggleSidebar()
    },
  })

  commandRegistry.register({
    id: 'app.toggle-right-panel',
    title: '切换右栏面板',
    category: 'View',
    keywords: ['panel', 'right', 'toggle'],
    shortcut: 'mod+j',
    action: () => {
      // ChatView 的 rightPanelVisible 是局部 ref，需要 emit 或全局化
      // 简化：用 uiStore
      const u = useUiStore()
      u.toggleRightPanel()
    },
  })

  commandRegistry.register({
    id: 'app.command-palette',
    title: '打开命令面板',
    category: 'App',
    keywords: ['palette', 'search', 'command'],
    shortcut: 'mod+k',
    // CommandPalette 自己监听 mod+k，这里注册只是为了让它在面板里可见
    action: () => {
      // dispatch 一个自定义事件，App.vue 监听后打开 palette
      window.dispatchEvent(new CustomEvent('catmax:open-command-palette'))
    },
  })

  // ⌘1-9 切换最近会话
  for (let i = 1; i <= 9; i++) {
    commandRegistry.register({
      id: `session.switch-${i}`,
      title: `切换到会话 ${i}`,
      category: 'Session',
      keywords: ['session', 'switch', `slot ${i}`],
      shortcut: `mod+${i}`,
      action: () => {
        const s = useSessionStore()
        const target = s.sessions[s.sessions.length - i]
        if (target) {
          s.setCurrent(target.id)
          void s.loadHistory(target.id)
        }
      },
    })
  }
```

### Step 3: 修改 ui store 加 rightPanelVisible

**Modify** `src/renderer/src/stores/ui.ts` —— 在原有字段后追加：

```ts
  const rightPanelVisible = ref(false)

  function toggleRightPanel(): void {
    rightPanelVisible.value = !rightPanelVisible.value
  }
```

return 加：

```ts
  return {
    sidebarCollapsed,
    settingsDialogOpen,
    rightPanelVisible,  // 🆕
    toggleSidebar,
    openSettings,
    closeSettings,
    toggleRightPanel,  // 🆕
  }
```

### Step 4: 修改 ChatView 用 uiStore 的 rightPanelVisible

**Modify** `src/renderer/src/views/ChatView.vue` —— 把原来的 local ref：

```ts
const rightPanelVisible = ref(false)
```

替换为：

```ts
import { useUiStore } from '@renderer/stores/ui'
const uiStore = useUiStore()
// 用 uiStore.rightPanelVisible 替代 local ref
```

template 里 `v-model` / `@click="rightPanelVisible = !rightPanelVisible"` 改用 uiStore。简化：

```vue
    <button
      class="absolute top-2 right-2 z-10 ..."
      @click="uiStore.toggleRightPanel()"
    >
      <PanelRightIcon class="w-4 h-4" />
    </button>

    <RightPanel :visible="uiStore.rightPanelVisible" />
```

并监听 `catmax:open-command-palette` 自定义事件（Task 6 step 2 加的）：

```ts
import { useUiStore } from '@renderer/stores/ui'

// 在 onMounted 里
onMounted(() => {
  window.addEventListener('catmax:open-command-palette', () => {
    uiStore.openCommandPalette()  // 需要在 uiStore 加这个 action
  })
})
```

uiStore 加：

```ts
  const commandPaletteVisible = ref(false)
  function openCommandPalette(): void {
    commandPaletteVisible.value = true
  }
  function closeCommandPalette(): void {
    commandPaletteVisible.value = false
  }
```

App.vue 改用 uiStore 的 commandPaletteVisible 替代 local ref（让命令系统能控制 palette）。

### Step 5: typecheck + lint + commit

```bash
pnpm typecheck && pnpm lint
git add src/renderer/src/lib/commandRegistry.ts src/renderer/src/lib/commands.ts src/renderer/src/stores/ui.ts src/renderer/src/views/ChatView.vue src/renderer/src/App.vue
git commit -m "feat(shortcuts): auto-bind shortcuts in commandRegistry + add cmd-n/b/j/1-9"
```

---

## Task 7: 打包发布（electron-builder 配置）

**Files:**
- Create: `electron-builder.yml`
- Modify: `package.json`（加 `dist` script + build 元数据）
- Create: `build/entitlements.mac.plist`（macOS 权限说明，不打 notarize 也要）

### Step 1: 创建 electron-builder.yml

Create `electron-builder.yml`：

```yaml
appId: com.catmax.app
productName: catmax
copyright: Copyright © 2026 shawn
directories:
  output: dist
  buildResources: build
files:
  - '!**/.vscode/*'
  - '!src/*'
  - '!docs/*'
  - '!tests/*'
  - '!*.md'
  - '!electron.vite.config.*'
  - '!{.eslintcache,.eslintrc.cjs,.prettierrc,.editorconfig}'
  - '!{.DS_Store,.git,.gitignore,.idea,.vscode}'
asarUnpack:
  - resources/**
  - '**/*.{node,dll}'

# macOS
mac:
  target:
    - target: dmg
      arch: [arm64, x64]
  category: public.app-category.developer-tools
  hardenedRuntime: true
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  # 不打 notarize（自用项目，省 Apple Developer 账号）
  # notarize: false

dmg:
  artifactName: ${productName}-${version}-${arch}.${ext}
  contents:
    - x: 130
      y: 220
    - x: 410
      'y': 220
      type: link
      path: /Applications

# Windows
win:
  target:
    - target: nsis
      arch: [x64]
  icon: build/icon.ico

nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  artifactName: ${productName}-Setup-${version}-${arch}.${ext}

# Linux（未来加）
# linux:
#   target:
#     - AppImage
#   category: Development

# 复制 better-sqlite3 和 node-pty 的 native binding
extraMetadata:
  main: ./out/main/index.js
```

### Step 2: 创建 build/entitlements.mac.plist

```bash
mkdir -p build
```

Create `build/entitlements.mac.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <key>com.apple.security.cs.allow-dyld-environment-variables</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
    <key>com.apple.security.network.client</key>
    <true/>
    <key>com.apple.security.network.server</key>
    <true/>
</dict>
</plist>
```

### Step 3: 修改 package.json 加 dist script + build 元数据

**Modify** `package.json` —— scripts 加 `dist`：

```json
    "dist:mac": "pnpm build && electron-builder --mac",
    "dist:win": "pnpm build && electron-builder --win",
    "dist": "pnpm build && electron-builder",
```

并在顶层加 build 配置的引用（如果用 electron-builder.yml 文件可以不加）。

顶层加（如果还没有）：

```json
"build": {
  "extends": "./electron-builder.yml"
}
```

但实际上 electron-builder 默认会读 `electron-builder.yml`，不需要在 package.json 里加。

### Step 4: 准备图标

需要 `build/icon.icns`（macOS）和 `build/icon.ico`（Windows）。MVP 用占位：

```bash
# 用现有 resources/icon.png 转
# 如果没 icns 工具，先用 png 占位（electron-builder 会警告但不阻塞 mac）
ls resources/icon.png
cp resources/icon.png build/icon.png 2>/dev/null
```

或者跳过图标（electron-builder 用默认 Electron 图标）。

### Step 5: 验证 dist

```bash
# 打 mac 包（首次会下载 electron-builder binary）
pnpm dist:mac 2>&1 | tail -20

# 期望：生成 dist/catmax-0.1.0-arm64.dmg 和 dist/catmax-0.1.0-x64.dmg
ls dist/*.dmg
```

如果失败，常见原因：
- 缺图标：跳过或补 `build/icon.icns`
- native binding 找不到：检查 `asarUnpack` 是否含 `**/*.{node,dll}`

### Step 6: 提交

```bash
git add electron-builder.yml build/ package.json
git commit -m "feat(packaging): add electron-builder config for dmg + nsis"
```

---

## Task 8: 集成验证 + smoke test

**Files:**
- Run: 全套测试 + typecheck + lint + dev 启动
- Create: `docs/superpowers/plans/2026-07-19-plan-5-smoke-test.md`

### Step 1: 全套自动化测试

```bash
pnpm rebuild:node
pnpm typecheck
pnpm lint
pnpm test
```

Expected: 152 + Plan 5 新增（~13 tests）= 165+ tests。

### Step 2: production build + dist

```bash
pnpm rebuild:native
pnpm dist:mac 2>&1 | tail -10
ls dist/*.dmg
```

### Step 3: dev 启动 + 走查

```bash
pnpm dev
```

可视化验证：

1. ✅ 启动后，Sidebar 显示历史会话列表
2. ✅ 点击某会话 → 看到"加载历史中"loading
3. ✅ 加载完成后看到完整对话（含 tool call 卡片）
4. ✅ 切到只读会话（其他后端）也能看历史
5. ✅ 按 ⌘N → 新建会话
6. ✅ 按 ⌘B → 切换 sidebar
7. ✅ 按 ⌘J → 切换右栏
8. ✅ 按 ⌘1/⌘2 → 切换会话
9. ✅ 按 ⌘, → 打开设置
10. ✅ 安装 dmg 后能打开 App

### Step 4: 写 smoke test

Create `docs/superpowers/plans/2026-07-19-plan-5-smoke-test.md`：

```markdown
# Plan 5 Smoke Test 端到端验证清单

## 自动化验证（已通过）

- [ ] `pnpm typecheck` 0 errors
- [ ] `pnpm lint` 0 errors
- [ ] `pnpm test` 165+ tests passing
- [ ] `pnpm dist:mac` 生成 dmg

## 可视化验证

### 会话历史回放
- [ ] 点击侧边栏会话立即 loading
- [ ] 加载完显示完整对话（user/assistant/tool）
- [ ] 只读会话（其他后端）也能看历史
- [ ] tool call 卡片正确渲染（exit code / diff）
- [ ] 历史不会显示 "running" 状态

### 快捷键
- [ ] ⌘K → 命令面板
- [ ] ⌘N → 新建会话
- [ ] ⌘B → 切换 sidebar
- [ ] ⌘J → 切换右栏
- [ ] ⌘, → 设置
- [ ] ⌘1-9 → 切换会话

### 打包
- [ ] dist/catmax-0.1.0-arm64.dmg 存在
- [ ] 双击 dmg → 出现 App 图标
- [ ] 拖到 Applications 后能打开
- [ ] App 内功能（聊天/终端/git）正常

## 总结

Plan 5 完成度：8/8 tasks ✅。
```

### Step 5: 提交

```bash
git add docs/superpowers/plans/2026-07-19-plan-5-smoke-test.md
git commit -m "docs: add Plan 5 smoke test checklist"
```

---

## Plan 5 完成标志

- ✅ 会话历史回放（codex + claude 都能读历史并显示）
- ✅ 完整快捷键体系（⌘K/N/B/J/,/1-9）
- ✅ macOS dmg + Windows nsis 打包
- ✅ 165+ tests 通过

---

## 自检

**1. Spec 覆盖**：补齐 README 路线图前三条短版（会话回放、打包、快捷键）。

**2. 占位符扫描**：无 TBD/TODO。`session.detail` 的 Plan 2 占位真正实现。

**3. 类型一致性**：
- `AgentBackend.getHistory` 新增方法，Codex/Claude Adapter 都实现
- `NormalizedMessage` 复用已有类型
- `Command.shortcut` 复用已有字段

**4. 已知简化**：
- claude getHistory 需要启动一个临时进程（成本较高，但只发生在用户点会话时）
- 打包不 notarize（自用项目）
- ⌘1-9 切换最近 9 个会话（不分页）
