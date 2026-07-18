# catmax-app 设计文档

> 一个自用的、Electron + Vue3 桌面 code agent 客户端，通过可插拔的后端协议适配器同时支持 `codex app-server` 和 `claude code`。
>
> **文档日期**：2026-07-18
> **状态**：已批准（brainstorming 完成，待实现计划）
> **范围**：一期 MVP

---

## 目录

- [一、项目定位与范围](#一项目定位与范围)
- [二、整体架构与目录结构](#二整体架构与目录结构)
- [三、后端抽象与 Normalized 事件模型](#三后端抽象与-normalized-事件模型)
- [四、数据模型与 IPC 契约](#四数据模型与-ipc-契约)
- [五、前端风格与主题系统](#五前端风格与主题系统)
- [六、规范技能（catmax-conventions）](#六规范技能catmax-conventions)
- [七、技术栈清单](#七技术栈清单)
- [八、成功标准](#八成功标准)

---

## 一、项目定位与范围

### 1.1 核心定位

- **自用 code agent 客户端**（不追求对外发布）
- **借鉴 Codex 架构思想**，但不复刻全部功能
- **后端解耦**：UI 不写死任何 LLM 协议，后端是可替换的

### 1.2 一期范围（In Scope）

| # | 能力 | 说明 |
|---|---|---|
| 1 | Electron + Vue3 应用骨架 | electron-vite + TypeScript |
| 2 | 聊天主界面 | 消息流 + 输入框 + 流式渲染 |
| 3 | 工作区模型 | 启动时选本地文件夹作为 CWD |
| 4 | 双后端适配器 | codex（JSON-RPC/stdio）+ claude（stream-json） |
| 5 | 会话持久化 | better-sqlite3 存对话历史索引 |
| 6 | 中断 + tool call approval | Stop 按钮、对工具调用批准/拒绝 |
| 7 | ⌘K 命令面板 | 切换工作区/会话/后端/设置 |
| 8 | 深/浅双主题 | 含可扩展主题系统 |
| 9 | macOS + Windows 双平台 | Linux 二期 |
| 10 | Git Status 面板（只读） | 文件列表、分支、未提交计数 |
| 11 | 文件树（只读浏览+预览） | 尊重 .gitignore |
| 12 | 内置终端 | xterm.js + node-pty，cwd = 工作区根 |
| 13 | 编辑器集成 | VS Code / Cursor / IntelliJ / WebStorm / Sublime |
| 14 | 设置页 | 后端配置、凭证管理、外观、工作区/会话、HTTP 代理 |

### 1.3 一期范围外（Out of Scope）

- ❌ Git 写操作（commit/push/branch/merge/rebase/PR）
- ❌ 文件内容编辑（仅预览，编辑走外部编辑器）
- ❌ 自动化引擎（cron）、Inbox、Cloud worktree 快照
- ❌ OAuth2 PKCE、VS Code 协议桥
- ❌ 自研 agent loop、多窗口、Linux 支持
- ❌ 跨后端会话迁移

---

## 二、整体架构与目录结构

### 2.1 三层进程架构

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 1: RENDERER  (Chromium webview, Vue3 + Vite)              │
│  Vue3 + Pinia + Vue Router + Tailwind + shadcn-vue              │
│  markdown-it + Shiki + Mermaid + xterm.js + Monaco (只读)        │
│  ⌘K 命令面板                                                    │
│  零业务逻辑 — 所有副作用走 IPC                                    │
└────────────────────────────┬────────────────────────────────────┘
                             │ contextBridge / ipcRenderer.invoke
                             │ (集中式 IPC Registry, 类型自动派生)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 2: MAIN  (Node.js, Electron main process)                 │
│  IPC Registry (按 domain 分文件, 9 个 domain)                    │
│  BackendManager + CodexAdapter + ClaudeAdapter                  │
│  PtyManager / EditorLauncher / GitService                       │
│  CredentialStore (safeStorage) / Database (better-sqlite3)      │
└────────────────────────────┬────────────────────────────────────┘
                             │ spawn + newline-delimited JSON
                             │ (Adapter 内部隔离协议)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 3: BACKEND  (外部 CLI 子进程, 可替换)                       │
│  • codex (app-server, JSON-RPC 2.0 over stdio)                 │
│  • claude (-p --output-format stream-json --input-format ...)  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 三个关键架构决策

1. **渲染层零业务逻辑**（学 Codex）—— 所有副作用（文件、git、pty、后端通信）走 IPC。
2. **集中式类型化 IPC**（Heckmann 模式）—— handler 函数签名即契约，类型自动派生到 renderer，契约永不漂移。
3. **BackendManager + Adapter**（方案 A）—— Manager 管生命周期，Adapter 管协议。新后端 = 新 Adapter 类。

### 2.3 目录结构（electron-vite 官方约定）

```
catmax-app/
├─ docs/                              # 已有 Codex 分析文档
│  ├─ Codex App 技术解析.md
│  ├─ Codex App 与 codex CLI 通信方式.md
│  └─ superpowers/specs/              # 本设计文档
│
├─ .agents/skills/catmax-conventions/ # 项目规范技能
│  ├─ SKILL.md
│  └─ references/{architecture,coding-style,ipc-pattern,backend-adapter,ui-conventions}.md
│
├─ electron.vite.config.ts            # electron-vite 单一配置点
├─ electron-builder.yml               # 打包配置
├─ package.json                       # packageManager: pnpm
├─ tsconfig.json / tsconfig.node.json / tsconfig.web.json
├─ tailwind.config.ts / postcss.config.js
├─ components.json                    # shadcn-vue 配置
├─ .editorconfig / .prettierrc / .eslintrc.cjs
│
└─ src/
   ├─ shared/                         # ★ 跨进程单一真源（仅类型和常量）
   │  ├─ ipc/                         # IPC 契约（按 domain）
   │  │  ├─ workspace.ts / session.ts / backend.ts / git.ts
   │  │  ├─ fs.ts / pty.ts / credential.ts / settings.ts / system.ts
   │  ├─ backend/                     # 后端抽象（跨进程共用类型）
   │  │  ├─ types.ts                  # AgentBackend 接口、NormalizedItem、TurnEvent
   │  │  └─ schema.ts                 # codex/claude 协议消息的 Zod schema
   │  ├─ domain.ts                    # Session / Message / Workspace 领域模型
   │  └─ constants.ts                 # 通道名、后端 ID、存储键名
   │
   ├─ main/                           # 主进程
   │  ├─ index.ts                     # app.whenReady 入口
   │  ├─ window.ts                    # BrowserWindow 管理
   │  ├─ context.ts                   # 主进程全局上下文（db、windows 等）
   │  ├─ ipc/
   │  │  ├─ typed.ts                  # 类型化 IPC 基础类（Heckmann 模式）
   │  │  ├─ register.ts               # 启动时统一注册所有 domain
   │  │  └─ domains/                  # 每个 domain 一个目录
   │  │     ├─ workspace/{handlers,events,index}.ts
   │  │     ├─ session/ backend/ git/ fs/ pty/ credential/ settings/ system/
   │  ├─ backend/                     # 后端实现
   │  │  ├─ manager.ts                # BackendManager（单例）
   │  │  ├─ codex/{adapter,protocol,mapping}.ts
   │  │  └─ claude/{adapter,protocol,mapping}.ts
   │  └─ service/                     # 主进程业务服务
   │     ├─ database.ts / schema.sql
   │     ├─ pty-manager.ts / editor-launcher.ts
   │     ├─ git-service.ts / credential-store.ts / proxy.ts
   │
   ├─ preload/
   │  ├─ index.ts                     # contextBridge.exposeInMainWorld
   │  └─ api.ts                       # 从 shared/ipc/* 自动派生 api 对象
   │
   └─ renderer/                       # 渲染层（Vue3）
      ├─ index.html
      └─ src/
         ├─ main.ts                   # createApp + pinia + router
         ├─ App.vue
         ├─ assets/styles/
         │  ├─ main.css               # tailwind 入口 + @theme 注册
         │  ├─ themes.css             # 深/浅主题 CSS vars（data-theme 属性）
         │  └─ code-themes/           # Shiki 主题
         ├─ router/index.ts           # hash router
         ├─ stores/                   # Pinia（workspace/session/message/backend/settings/ui）
         ├─ ipc/index.ts              # window.api 类型化包装
         ├─ views/                    # ChatView / SettingsView / WelcomeView
         ├─ components/
         │  ├─ chat/                  # MessageList, MessageItem, MarkdownView, CodeBlock, ToolCallCard, ApprovalDialog, Composer
         │  ├─ sidebar/ workspace/ git/ files/ terminal/ settings/ command/
         │  └─ ui/                    # ★ shadcn-vue 生成的基础组件
         ├─ composables/              # useTheme, useStreamMessage, useTerminal, useShortcut
         ├─ lib/                      # markdown.ts, shiki.ts, format.ts
         └─ env.d.ts                  # window.api 类型补全
```

### 2.4 关键修订点（相对于初稿）

| 方面 | 初稿（错） | 终稿（对） |
|---|---|---|
| 顶层目录 | `src/` + `src-electron/` | `src/{main,preload,renderer,shared}/` |
| IPC 类型来源 | 手写 Zod schema | **从 handler 函数签名自动派生**（Heckmann 模式） |
| Zod 用途 | 每个 IPC 都校验 | **只校验不可信外部输入**（子进程消息、磁盘配置、HTTP） |

---

## 三、后端抽象与 Normalized 事件模型

### 3.1 两个后端协议的关键差异（要被抽象层吃掉的）

| 维度 | codex app-server | claude code |
|---|---|---|
| 传输 | JSON-RPC 2.0 over stdio | newline-delimited stream-json over stdio |
| 握手 | `initialize` + `initialized` | 自动 `system/init` |
| 对话单元 | Thread → Turn → Item | session → assistant message → content[] |
| 流式文本 | `item/agentMessage/delta` | `assistant.message.content[].text` 累积 |
| 工具调用 | `item/started` (command/fileEdit/tool_call) | `content[].type=tool_use` |
| Approval | `approval` 反向请求 | `permission` 请求消息 |
| 中断 | `turn/interrupt` | 关闭 stdin / SIGINT |
| 模型选择 | `turn/start` 的 `model` 字段 + `model/list` | `--model <name>` 启动参数 |
| 推理强度 | `turn/start` 的 `effort`（值由模型决定） | `--effort low\|medium\|high\|xhigh\|max`（5 档固定） |
| 权限模式 | `permissionProfile` 或 `sandbox` | `--permission-mode`（6 档：default/acceptEdits/auto/plan/dontAsk/bypassPermissions） |

**关键洞察**：
- 两边 `permissionMode` 语义完全一致 → 共用枚举
- 两边都支持 `effort`，但档位不同 → 取并集，Adapter 负责映射/裁剪
- 两边都自己持久化完整对话 → App 不重复存全文

### 3.2 AgentBackend 接口（完整签名）

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

### 3.3 关键设计决策

1. **`AsyncIterable<TurnEvent>` 在 main 内部使用**——跨进程用 IPC push（`webContents.send('backend:turnEvent', ...)`），不做背压控制（单机桌面不需要）。
2. **turnId 是 App 内部生成**（UUID），Adapter 内部维护 `turnId → backendTurnId` 映射。
3. **approval.riskLevel 由 Adapter 评估**——每个 Adapter 维护命令模式 → 风险等级映射（low/medium/high）。
4. **steer 是可选方法**——接口用 `?`，UI 用前检查 `capabilities.supportsSteer`。
5. **历史会话"透传"**——App SQLite 只存索引，回放时调 `adapter.resumeSession` 拉全文。

### 3.4 NormalizedMessage（UI 永远只见这个）

```ts
interface NormalizedMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  turnId: string
  textBlocks?: { id: string; text: string; kind: 'text' | 'reasoning' }[]
  toolBlocks?: {
    id: string
    info: ToolCallInfo
    status: 'running' | 'completed' | 'failed'
    output?: ToolOutput
    approvalState?: 'pending' | 'approved' | 'rejected'
  }[]
  createdAt: number
}
```

**不变量**：`NormalizedMessage` 不含任何 `codex.*` 或 `claude.*` 字段。所有协议细节在 Adapter 边界蒸发。

### 3.5 切换后端的会话同步策略

- **会话永远属于创建它的后端**——`sessions.backend` 字段永久不变
- **当前后端**是 settings 里的全局状态，与会话归属无关
- **UI 分两区**：
  - "可继续"区：`session.backend === currentBackend` 的会话，可 resume、可继续聊
  - "其他后端（只读）"区：折叠显示，点击用会话自己的后端拉全文，不能继续聊
- **跨后端继续聊不允许**——必须切回原后端
- **对账策略**：启动/切工作区时，调 `adapter.listSessions(cwd)` 与 App SQLite 对账，补登记新增、标记 stale

---

## 四、数据模型与 IPC 契约

### 4.1 SQLite Schema

```sql
-- src/main/service/schema.sql

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE workspaces (
  id              TEXT PRIMARY KEY,
  path            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  preferred_editor TEXT,
  last_opened_at  INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,
  backend           TEXT NOT NULL,             -- 'codex' | 'claude'（永久）
  backend_thread_id TEXT NOT NULL,             -- 后端原生对话 id（codex 是 thr_xxx，claude 是 session-uuid；统一命名)
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title             TEXT,
  model             TEXT,
  effort            TEXT,
  permission_mode   TEXT,
  turn_count        INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  last_active_at    INTEGER NOT NULL,
  UNIQUE(backend, backend_thread_id)
);

CREATE INDEX idx_sessions_workspace ON sessions(workspace_id, last_active_at DESC);
CREATE INDEX idx_sessions_backend   ON sessions(workspace_id, backend);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id         TEXT NOT NULL,
  role            TEXT NOT NULL,                -- 'user' | 'assistant'
  text_preview    TEXT NOT NULL,                -- 前 200 字符
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_messages_session ON messages(session_id, created_at);
CREATE INDEX idx_messages_search ON messages(text_preview);

CREATE TABLE app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                          -- JSON 序列化
);
-- 预置 key: last_workspace_id / current_backend / last_runtime_config / command_palette_history
```

### 4.2 IPC Domain 划分（9 个 domain）

| Domain | 方法数 | 职责 |
|---|---|---|
| `workspace` | 5 | 工作区 CRUD、设当前 |
| `session` | 6 | 会话 CRUD、对账 |
| `backend` | 7 | 后端管理、turn 流、approval、interrupt |
| `git` | 2 | 只读 status、branch |
| `fs` | 5 | 文件树、读文件、用编辑器打开 |
| `pty` | 4 | 终端创建/写/resize/kill |
| `credential` | 4 | API key 加密 CRUD |
| `settings` | 4 | 读写配置、主题、HTTP 代理 |
| `system` | 3 | 平台信息、dialog、open-external |

### 4.3 关键 IPC 契约（摘录）

完整签名见 `src/shared/ipc/*`，下面是核心几个：

```ts
// backend —— 最复杂的 domain
export async function startTurn(args: {
  sessionId: string
  prompt: string
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
}): Promise<{ turnId: string }>

export async function interruptTurn(args: { turnId: string }): Promise<void>
export async function respondApproval(args: {
  requestId: string
  action: 'approve' | 'reject' | 'approve_always'
}): Promise<void>

// 主→渲染推送事件
// 'backend:turnEvent'      (turnId, event: TurnEvent)
// 'backend:switched'       (id: BackendId)
// 'backend:statusChanged'  (status: BackendStatus)

// session —— 含对账
export async function reconcileSessions(args: { workspaceId: string }): Promise<{
  added: SessionView[]
  removed: string[]
}>
```

### 4.4 安全规则

- **API key 用 `electron.safeStorage` 加密**（macOS Keychain / Windows DPAPI）
- **API key 经环境变量传子进程，绝不写命令行**（避免进程列表泄漏）
- **`getCredential` 仅在 settings 页面"测试连接"流程中调用**，绝不推给聊天 UI
- **Zod 只用在跨边界**：磁盘 settings.json、子进程 JSON、HTTP 响应。IPC 参数由 TS 类型系统保证。

### 4.5 命名约定

| 类型 | 约定 | 例子 |
|---|---|---|
| IPC 方法（请求-响应） | `domain.verb` | `workspace.list` |
| IPC 推送事件（主→渲染） | `domain:event` | `backend:turnEvent` |
| 类型/接口 | PascalCase | `WorkspaceRecord` |
| 函数/变量 | camelCase | `listWorkspaces` |
| 常量 | SCREAMING_SNAKE | `MAX_PREVIEW_SIZE` |
| 文件（组件） | PascalCase.vue | `MessageItem.vue` |
| 文件（其他） | kebab-case.ts | `backend-manager.ts` |

---

## 五、前端风格与主题系统

### 5.1 视觉风格（参考 Codex）

- **极简、克制**——大量留白、低对比层次
- **深色为主、浅色对称**——非纯黑/纯白，带色调的中性色
- **三种字体分用**：UI 字体、聊天文本字体、代码字体（各自独立）
- **无气泡消息设计**（区别于 ChatGPT）——全宽布局，头像+名字+正文
- **Composer 居底、无边框感**
- **气质**：developer-tool 而非 consumer-app

### 5.2 三层 token 架构

```
Layer 1: 原始 token（Reference）—— 色板原料，OKLCH 表示
  --color-gray-0 ... --color-gray-950
  --color-brand-500
  --color-success / warning / danger

Layer 2: 语义 token（System）—— ★ 组件唯一能引用的层
  --background / --foreground / --primary / --muted / --border ...
  组件代码只写 bg-background / text-foreground，永远不写具体色

Layer 3: 组件 token（Component）—— 按需，特定组件细节
  --sidebar-background / --composer-background / --code-block-background
```

### 5.3 主题切换：`data-theme` 属性

```html
<html data-theme="dark">         <!-- 默认深色 -->
<html data-theme="light">        <!-- 日间 -->
<html data-theme="system">       <!-- 跟随系统 -->
<html data-theme="midnight">     <!-- 二期可加 -->
```

**CSS 结构**（`src/renderer/src/assets/styles/themes.css`）：

```css
[data-theme="dark"] {
  --color-gray-100: oklch(18% 0.006 250);
  --color-brand-500: oklch(70% 0.15 250);
  /* ... Layer 1 ... */
}
[data-theme="dark"] {
  --background: var(--color-gray-100);
  --foreground: var(--color-gray-900);
  --primary: var(--color-brand-500);
  /* ... Layer 2 ... */
}
[data-theme="light"] { /* ... light 派生 ... */ }
```

**Tailwind v4 集成**（`main.css`）：

```css
@import "tailwindcss";
@import "./themes.css";

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-primary: var(--primary);
  /* ... */
  --font-sans: var(--font-sans);
  --font-chat: var(--font-chat);
  --font-mono: var(--font-mono);
}
```

### 5.4 主题可扩展性的四个扩展点

1. **加新主题（开发者）**——在 `themes.css` 加 `[data-theme="xxx"]` 块，组件零修改
2. **用户自定义（settings）**——`theme.overrides` 字段，运行时注入 `<style id="user-theme-overrides">`
3. **导入/导出（二期）**——主题是 JSON，支持 `.catmax-theme.json` 文件分享
4. **跟随系统**——`system` 模式监听 `prefers-color-scheme`

### 5.5 三个字体 token

| Token | 用途 | 默认值 |
|---|---|---|
| `--font-sans` | UI（按钮、菜单、对话框、侧边栏） | Inter |
| `--font-chat` | 聊天消息正文 | Inter |
| `--font-mono` | 代码块、终端、命令、diff | JetBrains Mono |

### 5.6 主题相关硬性规则

1. **组件只能引用 Layer 2 语义 token**，绝不写具体颜色（`bg-[#1a1a1a]` 禁止）。ESLint 强制。
2. **新加主题 = 加 CSS 块，不改组件**。
3. **`data-theme` 是唯一切换开关**，不在 JS 里操作样式。
4. **三个字体 token 互不替代**。
5. **OKLCH 而非 HEX/HSL**。

---

## 六、规范技能（catmax-conventions）

为防止后续迭代发散，所有架构 + 编码规范固化为项目级 ZCode 技能：

```
catmax-app/.agents/skills/catmax-conventions/
├─ SKILL.md                         # 触发条件 + 总览 + 五条硬性规则
└─ references/
   ├─ architecture.md               # 三层进程、目录约定、跨层 import 规则
   ├─ coding-style.md               # 命名、TS 配置、ESLint/Prettier、Vue SFC 结构
   ├─ ipc-pattern.md                # IPC 三件套模板（新增 domain 6 步流程）
   ├─ backend-adapter.md            # AgentBackend 接口、新增适配器步骤
   └─ ui-conventions.md             # shadcn-vue、主题系统、组件命名、字体
```

**触发条件**：在 catmax-app 里写/改/审代码时自动触发，包括加 IPC handler、后端 adapter、Vue 组件、service、改目录结构。

**放 `.agents/skills/`**（非 `.zcode/skills/`）——标准跨工具位置，跟着 git 走，团队/多设备一致。

---

## 七、技术栈清单

### 7.1 渲染层

| 类别 | 选择 | 用途 |
|---|---|---|
| 框架 | Vue 3 + TypeScript | 响应式 UI |
| 构建 | electron-vite + Vite 5+ | HMR、打包 |
| 状态 | Pinia | store |
| 路由 | Vue Router（hash 模式） | Electron 兼容 |
| UI 库 | Tailwind CSS v4 + shadcn-vue | 组件 + 主题 |
| 命令面板 | v-cmdk 或自实现 | ⌘K |
| Markdown | markdown-it + Shiki + Mermaid | 渲染 + 高亮 + 图表 |
| 终端 | xterm.js + xterm-addon-fit | 内置终端 |
| 文件预览 | Monaco editor（只读） | 代码预览 |

### 7.2 主进程

| 类别 | 选择 | 用途 |
|---|---|---|
| 数据库 | better-sqlite3 | 同步、本地存储 |
| PTY | node-pty | 真终端 |
| Git | simple-git | 只读 status |
| Schema 校验 | Zod | 不可信输入（子进程消息、磁盘 JSON） |
| 状态不可变 | immer | handler 内状态更新 |
| Lodash | lodash + memoizee | 工具函数 |

### 7.3 后端子进程

- **codex**: `codex app-server --listen stdio://`（JSON-RPC 2.0）
- **claude**: `claude -p --output-format stream-json --input-format stream-json --verbose`

### 7.4 工程化

| 类别 | 选择 |
|---|---|
| 包管理 | pnpm 10+ |
| TS 配置 | `strict: true` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| ESLint | `@vue/eslint-config-typescript` + `eslint-plugin-vue` |
| Prettier | 默认 + `singleQuote: true` + `semi: false` |
| Commit | Conventional Commits（`feat:` / `fix:` / `refactor:` / `docs:` / `chore:`） |
| 平台 | macOS（arm64 + x64）+ Windows（x64） |

---

## 八、成功标准

MVP 完成时可以：

1. 启动 App → 选一个本地 git repo 作为工作区
2. 切换 `codex` 或 `claude` 后端
3. 在 Composer 选模型 / effort / 权限模式
4. 发送一条 prompt，看到流式输出（含 markdown / 代码高亮）
5. agent 调用 tool 时弹出 approval，可以批准/拒绝
6. 中途点 Stop 能中断
7. 关闭 App 再打开，会话历史还在（可继续 vs 只读分区）
8. ⌘K 能快速切换工作区/会话/后端
9. 看到 git status 面板
10. 浏览文件树、点文件预览
11. 在内置终端跑命令
12. 用 VS Code（或其他 4 个之一）打开当前文件
13. 在设置里改后端路径 / 代理 / API key / 主题 / 字体
14. 切换深/浅主题，跟随系统

---

## 参考来源

### 架构与 IPC
- [electron-vite 官方文档](https://electron-vite.org/guide/)
- [Michael Heckmann – Type-safe IPC in Electron](https://heckmann.app/en/blog/electron-ipc-architecture)
- [EIPC – Type-safe Electron IPC](https://electron-ipc.com/)
- [Codex App 技术解析](../Codex%20App%20技术解析.md)
- [Codex App 与 codex CLI 通信方式](../Codex%20App%20与%20codex%20CLI%20通信方式.md)

### 后端协议
- [codex-rs/app-server/README.md（协议权威）](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Effort Levels 官方](https://platform.claude.com/docs/en/build-with-claude/effort)

### 主题与 UI
- [shadcn/ui Theming](https://ui.shadcn.com/docs/theming)
- [shadcn-vue CLI](https://www.shadcn-vue.com/docs/cli)
- [Tailwind v4 OKLCH](https://medium.com/design-bootcamp/tailwind-v4-oklch-why-your-colors-got-better-without-changing-class-names-5e7e7565ee1e)
- [Codex 字体策略 issue #25281](https://github.com/openai/codex/issues/25281)
- [Introducing the Codex App](https://openai.com/index/introducing-the-codex-app/)

---

*文档版本：v1.0（2026-07-18）*
*下一步：调用 writing-plans 技能生成实现计划*
