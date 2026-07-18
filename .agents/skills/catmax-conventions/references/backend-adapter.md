# 后端适配器规范

catmax-app 通过可插拔的 Adapter 同时支持 `codex app-server` 和 `claude code`。所有协议细节必须在 Adapter 边界蒸发——UI 永远只见 `TurnEvent` / `NormalizedMessage`。

## AgentBackend 接口（完整签名）

```ts
// src/shared/backend/types.ts

export type BackendId = 'codex' | 'claude'

export type PermissionMode =
  | 'default' | 'acceptEdits' | 'auto' | 'plan' | 'dontAsk' | 'bypassPermissions'

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ModelOption {
  id: string
  displayName: string
  backendSpecific?: boolean
  supportedEfforts?: EffortLevel[]
  isDefault?: boolean
  description?: string
}

export interface BackendCapabilities {
  supportsInterrupt: boolean
  supportsApproval: boolean
  supportsSteer: boolean
  supportsThreadFork: boolean
  supportsModelSelection: boolean
  supportsEffort: boolean
  supportsPermissionMode: boolean
  supportedPermissionModes: PermissionMode[]
  supportedEfforts: EffortLevel[]
}

export interface StartSessionArgs {
  cwd: string
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
  initialPrompt?: string
}

export interface StartTurnArgs {
  sessionId: string
  prompt: string
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
}

export type TurnEvent =
  | { type: 'turn_started'; turnId: string; sessionId: string }
  | { type: 'text_delta'; turnId: string; itemId: string; text: string }
  | { type: 'reasoning_delta'; turnId: string; itemId: string; text: string }
  | { type: 'tool_call_started'; turnId: string; itemId: string; tool: ToolCallInfo }
  | { type: 'tool_call_completed'; turnId: string; itemId: string; output: ToolOutput }
  | { type: 'approval_requested'; turnId: string; requestId: string; request: ApprovalRequest }
  | { type: 'error'; turnId: string; message: string; recoverable: boolean }
  | { type: 'turn_completed'; turnId: string; status: 'completed' | 'interrupted' | 'error'; usage?: TokenUsage }

export interface ToolCallInfo {
  kind: 'shell_command' | 'file_edit' | 'file_read' | 'mcp' | 'other'
  title: string
  detail?: string
}

export interface ToolOutput {
  ok: boolean
  summary: string
  output?: string
}

export interface ApprovalRequest {
  kind: 'shell_command' | 'file_edit' | 'mcp'
  title: string
  detail: string
  riskLevel: 'low' | 'medium' | 'high'
}

export interface ApprovalDecision {
  requestId: string
  action: 'approve' | 'reject' | 'approve_always'
}

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  costUsd?: number
}

export interface AgentBackend {
  readonly id: BackendId
  readonly capabilities: BackendCapabilities

  initialize(): Promise<void>
  healthCheck(): Promise<{ ok: boolean; version?: string; error?: string }>
  dispose(): Promise<void>

  listModels(): Promise<ModelOption[]>
  getCapabilities(): BackendCapabilities

  startSession(args: StartSessionArgs): Promise<{ sessionId: string; backendThreadId: string }>
  listSessions(cwd?: string): Promise<SessionSummary[]>
  resumeSession(sessionId: string): Promise<SessionDetail>

  startTurn(args: StartTurnArgs): AsyncIterable<TurnEvent>

  interrupt(turnId: string): Promise<void>
  respondApproval(decision: ApprovalDecision): Promise<void>
  steer?(turnId: string, prompt: string): Promise<void>
}
```

## Adapter 文件结构（每个后端三件套）

```
src/main/backend/<id>/
├─ adapter.ts     # AgentBackend 实现 + 状态机
├─ protocol.ts    # 原始协议解析（JSON-RPC / stream-json）+ Zod schema
└─ mapping.ts     # 原始消息 → TurnEvent 的映射规则
```

**职责分离**：
- `protocol.ts`：只管"字节流 ↔ 结构化消息"，不做语义解释
- `mapping.ts`：只管"原始消息 → TurnEvent"的转换，不接触字节流
- `adapter.ts`：协调两者、维护状态机、实现 AgentBackend 接口

这样协议解析和业务映射可以独立修改、独立测试。

## 现有两个 Adapter 的能力声明

### CodexAdapter

```ts
// src/main/backend/codex/adapter.ts
class CodexAdapter implements AgentBackend {
  readonly id = 'codex'
  readonly capabilities: BackendCapabilities = {
    supportsInterrupt: true,
    supportsApproval: true,
    supportsSteer: true,             // turn/steer
    supportsThreadFork: true,        // thread/fork
    supportsModelSelection: true,
    supportsEffort: true,
    supportsPermissionMode: true,
    supportedPermissionModes: ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'],
    supportedEfforts: ['low', 'medium', 'high'],   // 实际值由 model/list 决定
  }
}
```

### ClaudeAdapter

```ts
// src/main/backend/claude/adapter.ts
class ClaudeAdapter implements AgentBackend {
  readonly id = 'claude'
  readonly capabilities: BackendCapabilities = {
    supportsInterrupt: true,
    supportsApproval: true,
    supportsSteer: false,            // claude MVP 不支持
    supportsThreadFork: false,
    supportsModelSelection: true,
    supportsEffort: true,
    supportsPermissionMode: true,
    supportedPermissionModes: ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'],
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  }
}
```

## 关键设计决策（必须遵守）

### 1. turnId 是 App 内部生成（UUID）

```ts
async *startTurn(args: StartTurnArgs): AsyncIterable<TurnEvent> {
  const internalTurnId = crypto.randomUUID()
  yield { type: 'turn_started', turnId: internalTurnId, sessionId: args.sessionId }
  
  // 内部维护映射
  const backendTurn = await this.sendRequest('turn/start', { threadId: ..., prompt: ... })
  this.turnMap.set(internalTurnId, backendTurn.id)
  
  // 订阅本 turn 的事件流
  yield* this.subscribeToTurnEvents(internalTurnId)
}
```

**为什么**：UI 在 turn 开始的瞬间就需要 turnId（订阅事件、显示 loading、绑定 interrupt）。不等后端返回。

### 2. `AsyncIterable<TurnEvent>` 在 Adapter 内使用

```ts
async *startTurn(args): AsyncIterable<TurnEvent> {
  yield { type: 'turn_started', ... }
  while (true) {
    const raw = await this.readNextMessage()
    if (raw.method === 'turn/completed') {
      yield { type: 'turn_completed', status: 'completed', ... }
      return
    }
    yield* mapRawToEvents(raw)   // mapping.ts 的工作
  }
}
```

**为什么**：天然表达"流式 + 可中断"。interrupt 时设标志，下次循环 break。

### 3. 跨进程用 IPC push（不用 AsyncIterable）

```ts
// src/main/backend/manager.ts
class BackendManager {
  async startTurn(args: StartTurnArgs): Promise<{ turnId: string }> {
    const adapter = this.getCurrentAdapter()
    const turnId = crypto.randomUUID()
    
    // 后台驱动 AsyncIterable
    void (async () => {
      try {
        for await (const event of adapter.startTurn(args)) {
          this.broadcastToRenderers('backend:turnEvent', { turnId, event })
        }
      } catch (err) {
        this.broadcastToRenderers('backend:turnEvent', {
          turnId,
          event: { type: 'error', message: String(err), recoverable: false },
        })
      }
    })()
    
    return { turnId }
  }
}
```

**为什么不用 AsyncIterable 跨进程**：Electron IPC 不天然支持，需要 pull 协议或第三方库（electron-ipc-stream）。MVP 不值得。单机桌面 IPC 吞吐量远高于 LLM 输出速率，不需要背压。

### 4. 历史"透传"，App 不存全文

App SQLite 只存索引（id、title、time）。回放时：

```ts
async resumeSession(sessionId: string): Promise<SessionDetail> {
  const record = await db.sessions.findById(sessionId)
  const adapter = this.adapters.get(record.backend)   // ★ 用会话的后端
  const detail = await adapter.resumeSession(record.backendThreadId)
  return detail
}
```

**Adapter 内部**调 codex 的 `thread/read` 或 claude 的 `--resume <id>` 拉全文。

### 5. approval.riskLevel 由 Adapter 评估

```ts
// src/main/backend/codex/mapping.ts
function assessRisk(kind: ToolCallInfo['kind'], detail: string): 'low' | 'medium' | 'high' {
  if (kind === 'shell_command') {
    if (/^(git status|git log|ls|cat|pwd|grep|find|rg)\b/.test(detail)) return 'low'
    if (/\b(rm|git push|git push --force|npm publish|git reset --hard|sudo)\b/.test(detail)) return 'high'
    return 'medium'
  }
  if (kind === 'file_edit') return 'medium'    // 文件编辑默认 medium
  if (kind === 'file_read') return 'low'
  return 'medium'
}
```

规则简单（< 20 条），每个 Adapter 独立维护（codex 命令 vs claude tool_use 可能不同）。

UI 根据风险等级：
- `low` → 默认批准按钮高亮
- `medium` → 默认批准，但需确认
- `high` → 默认拒绝按钮高亮 + 红色边框

### 6. steer 是可选方法

```ts
interface AgentBackend {
  steer?(turnId: string, prompt: string): Promise<void>
}
```

UI 使用前检查：

```ts
if (backend.capabilities.supportsSteer && backend.steer) {
  await backend.steer(turnId, '请加上单元测试')
} else {
  // UI 隐藏"中途补充说明"按钮
}
```

## 切换后端的会话归属规则

```ts
// src/main/backend/manager.ts
class BackendManager {
  // 当前后端（来自 settings）
  currentBackendId: BackendId = settings.defaultBackend
  
  async switchBackend(id: BackendId): Promise<void> {
    await this.ensureInitialized(id)
    this.currentBackendId = id
    this.broadcast('backend:switched', { id })
    // UI 收到后：
    //   1. 重新加载会话列表（continuable vs 只读分区）
    //   2. 重新加载模型列表
    //   3. 清空当前运行的 turn
  }
  
  // 用会话自己的后端，不是当前后端
  async resumeSession(sessionId: string): Promise<SessionDetail> {
    const record = await db.sessions.findById(sessionId)
    const adapter = this.adapters.get(record.backend)   // ★ 关键
    return adapter.resumeSession(record.backendThreadId)
  }
  
  // 继续聊天：当前后端必须匹配
  async startTurnOnSession(sessionId: string, args: StartTurnArgs): Promise<{ turnId: string }> {
    const record = await db.sessions.findById(sessionId)
    if (record.backend !== this.currentBackendId) {
      throw new BackendError(
        'mismatch',
        `Session backend is ${record.backend}, current is ${this.currentBackendId}`,
      )
    }
    const adapter = this.adapters.get(record.backend)
    return this.startTurn(adapter, args)
  }
}
```

**关键不变量**：会话永远属于创建它的后端。`sessions.backend` 字段永久不变。

## 新增后端适配器的步骤

以未来加 Aider 为例：

### Step 1: 在 `shared/backend/types.ts` 加 BackendId

```ts
export type BackendId = 'codex' | 'claude' | 'aider'
```

### Step 2: 新建目录和三件套

```
src/main/backend/aider/
├─ adapter.ts
├─ protocol.ts
└─ mapping.ts
```

```ts
// src/main/backend/aider/adapter.ts
export class AiderAdapter implements AgentBackend {
  readonly id = 'aider'
  readonly capabilities: BackendCapabilities = {
    supportsInterrupt: true,
    supportsApproval: false,         // aider 没有原生 approval
    supportsSteer: false,
    supportsThreadFork: false,
    supportsModelSelection: true,
    supportsEffort: false,
    supportsPermissionMode: false,
    supportedPermissionModes: [],
    supportedEfforts: [],
  }
  // ... 实现
}
```

### Step 3: 在 BackendManager 注册

```ts
// src/main/backend/manager.ts
class BackendManager {
  constructor() {
    this.adapters.set('codex', new CodexAdapter())
    this.adapters.set('claude', new ClaudeAdapter())
    this.adapters.set('aider', new AiderAdapter())  // 🆕
  }
}
```

### Step 4: 在 settings 加 healthCheck 入口

```ts
// 在 settings domain handler 里
export async function listBackends(): Promise<BackendStatus[]> {
  return Promise.all(
    (['codex', 'claude', 'aider'] as BackendId[]).map(async (id) => {
      const adapter = ctx.manager.getAdapter(id)
      const health = await adapter.healthCheck()
      return {
        id,
        available: health.ok,
        version: health.version,
        error: health.error,
        capabilities: adapter.capabilities,
      }
    }),
  )
}
```

### Step 5: 加测试

```ts
// src/main/backend/aider/adapter.test.ts
test('aider output line maps to text_delta', async () => {
  const mock = mockStdout([
    { type: 'assistant', content: 'hello' },
    // ...
  ])
  const adapter = new AiderAdapter({ spawn: () => mock })
  const events = []
  for await (const e of adapter.startTurn({ sessionId: 's1', prompt: 'hi' })) {
    events.push(e)
  }
  expect(events[0]).toMatchObject({ type: 'text_delta', text: 'hello' })
})
```

**完成后 UI 零修改**——因为依赖抽象，不依赖具体后端。新后端 capabilities 不支持的功能自动隐藏。

## 测试策略

### Adapter 测试（最重要）

注入 mock spawn，断言 TurnEvent 序列：

```ts
// src/main/backend/codex/adapter.test.ts
import { describe, test, expect } from 'vitest'
import { CodexAdapter } from './adapter'

test('codex agentMessage/delta → text_delta', async () => {
  const mockProc = createMockProcess({
    stdoutLines: [
      { method: 'item/agentMessage/delta', params: { turnId: 't1', delta: 'hello' } },
      { method: 'turn/completed', params: { turnId: 't1', status: 'completed' } },
    ],
  })
  
  const adapter = new CodexAdapter({ spawn: () => mockProc })
  await adapter.initialize()
  
  const events = []
  for await (const e of adapter.startTurn({ sessionId: 's1', prompt: 'hi' })) {
    events.push(e)
  }
  
  expect(events[0]).toMatchObject({ type: 'text_delta', text: 'hello' })
  expect(events.at(-1)).toMatchObject({ type: 'turn_completed', status: 'completed' })
})
```

### 关键测试场景（每个 Adapter 必须覆盖）

1. 文本流式输出 → 多个 `text_delta` + 一个 `turn_completed`
2. tool 调用 → `tool_call_started` + `tool_call_completed`
3. approval 请求 → `approval_requested`，调用 respondApproval 后继续
4. 中断 → 调用 `interrupt()` 后收到 `turn_completed` (status: 'interrupted')
5. 协议错误 → `error` 事件 + recoverable 标志
6. 子进程崩溃 → `error` 事件 + reconnect 尝试

## 协议变更处理

codex/claude 升级后协议可能变。处理策略：

1. **在 `protocol.ts` 用 Zod 严格校验**——协议变了立刻报错（不是悄悄解错）
2. **测试用真实协议样本**——抓真实 stdout 存为 fixture，CI 跑一遍
3. **版本探测**：`initialize` 时记录 codex/claude 版本，协议不兼容时给用户明确升级提示

```ts
// src/main/backend/codex/protocol.ts
import { z } from 'zod'

export const AgentMessageDeltaSchema = z.object({
  method: z.literal('item/agentMessage/delta'),
  params: z.object({
    turnId: z.string(),
    delta: z.string(),
  }),
})

// 收到无法解析的消息
if (result.success === false) {
  throw new BackendError('protocol', `Unrecognized codex message: ${JSON.stringify(raw)}`)
}
```

## 反模式（看到立即拒绝）

### ❌ UI 见到协议字段

```ts
// renderer 里
if (message.codexItem.type === 'agentMessage') { ... }
```

**正确**：协议字段在 Adapter mapping 蒸发，UI 只看 NormalizedMessage。

### ❌ Adapter 直接 webContents.send

```ts
// adapter 不应该知道有 renderer
class CodexAdapter {
  badEmit(wc: WebContents) {
    wc.send('something', ...)   // ❌
  }
}
```

**正确**：Adapter 只 `yield TurnEvent`，由 BackendManager 推送。

### ❌ 多个 Adapter 实例

```ts
const adapter1 = new CodexAdapter()
const adapter2 = new CodexAdapter()   // ❌
```

**正确**：每个后端**只有一个实例**，由 BackendManager 单例管理。
