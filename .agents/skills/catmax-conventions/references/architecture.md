# 架构规范

## 三层进程模型（铁律，不可越）

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: RENDERER  (Chromium webview, Vue3)                 │
│   Vue3 + Pinia + Vue Router + Tailwind + shadcn-vue         │
│   零业务逻辑 — 所有副作用走 IPC                              │
└──────────────────────────┬──────────────────────────────────┘
                           │ contextBridge / ipcRenderer.invoke
                           │ (集中式 IPC Registry, 类型自动派生)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 2: MAIN  (Node.js, Electron main process)             │
│   IPC Registry (按 domain 分文件)                            │
│   BackendManager + CodexAdapter + ClaudeAdapter             │
│   PtyManager / EditorLauncher / GitService / Database       │
└──────────────────────────┬──────────────────────────────────┘
                           │ spawn + newline-delimited JSON
                           │ (Adapter 内部隔离协议)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 3: BACKEND  (外部 CLI 子进程, 可替换)                   │
│   codex (app-server, JSON-RPC) / claude (stream-json)       │
└─────────────────────────────────────────────────────────────┘
```

## 跨层 import 规则（强制）

```
renderer/  →  可以 import: shared/、renderer 内部、第三方（仅浏览器可用）
             禁止 import: main/、preload/、electron、node:*

main/      →  可以 import: shared/、main 内部、electron、node:*、第三方
             禁止 import: renderer/

preload/   →  可以 import: shared/、electron（仅 contextBridge/ipcRenderer）
             禁止 import: main/、renderer/、node:*（除白名单）

shared/    →  可以 import: 仅 shared 内部 + 第三方类型库
             禁止 import: main/、renderer/、preload/、electron、node:*
```

**为什么这么严**：
- 渲染层是沙箱，碰 Node 会运行时报错
- shared 是契约层，引入运行时依赖会污染两端
- 主进程的副作用不应该被渲染层直接触发（必须经 IPC）

ESLint 用 `no-restricted-imports` 规则强制上述约束。

## 目录约定

### `src/shared/`（跨进程单一真源）

只放**类型和常量**，不放运行时逻辑（除纯函数工具）。

```
shared/
├─ ipc/          # IPC 契约（按 domain 一个文件）
│  ├─ workspace.ts   # 含 handler 函数签名 + 类型
│  ├─ session.ts
│  ├─ backend.ts
│  ├─ git.ts / fs.ts / pty.ts
│  ├─ credential.ts / settings.ts / system.ts
├─ backend/      # 后端抽象的跨进程类型
│  ├─ types.ts       # AgentBackend、TurnEvent、NormalizedMessage
│  └─ schema.ts      # Zod schema（解析子进程 JSON 用）
├─ domain.ts     # Session / Message / Workspace 领域模型
└─ constants.ts  # 通道名、BackendId、存储键名、EditorId
```

**判断标准**：如果一个文件被 main 和 renderer 同时 import，必须在 `shared/`。

### `src/main/`（主进程）

```
main/
├─ index.ts              # app.whenReady 入口
├─ window.ts             # BrowserWindow 管理
├─ context.ts            # 全局上下文（db、windows、manager 单例）
├─ ipc/
│  ├─ typed.ts           # 类型化 IPC 基础类（Heckmann 模式）
│  ├─ register.ts        # app.whenReady 时统一注册所有 domain
│  └─ domains/<domain>/
│     ├─ handlers.ts     # handler 实现（类型从函数签名派生）
│     ├─ events.ts       # 主→渲染推送（流式事件）
│     └─ index.ts        # 聚合导出
├─ backend/
│  ├─ manager.ts         # BackendManager 单例
│  ├─ codex/{adapter,protocol,mapping}.ts
│  └─ claude/{adapter,protocol,mapping}.ts
└─ service/              # 主进程业务服务
   ├─ database.ts        # better-sqlite3 封装
   ├─ pty-manager.ts     # node-pty 实例池
   ├─ editor-launcher.ts # 5 个编辑器启动
   ├─ git-service.ts     # simple-git（只读）
   ├─ credential-store.ts # Electron safeStorage
   └─ proxy.ts           # HTTP 代理
```

**何时新增 service vs IPC handler**：
- **service**：可复用的业务能力（如 `Database`、`PtyManager`），无 IPC 概念
- **handler**：暴露给渲染层的接口，内部调 service

### `src/preload/`（预加载）

```
preload/
├─ index.ts     # contextBridge.exposeInMainWorld('api', api)
└─ api.ts       # 从 shared/ipc/* 自动派生 api 对象
```

**只做桥接，不写业务**。

### `src/renderer/`（渲染层）

```
renderer/src/
├─ main.ts              # createApp + pinia + router
├─ App.vue
├─ assets/styles/       # main.css + themes.css + code-themes/
├─ router/index.ts
├─ stores/              # Pinia（每领域一个 store）
├─ ipc/index.ts         # window.api 类型化包装
├─ views/               # 路由页面
├─ components/
│  ├─ chat/ sidebar/ workspace/ git/ files/ terminal/ settings/ command/
│  └─ ui/               # shadcn-vue 生成的基础组件（不要手写）
├─ composables/         # useXxx 组合函数
└─ lib/                 # 纯函数（markdown.ts、shiki.ts、format.ts）
```

## BackendManager 单例规则

主进程**只有一个** `BackendManager` 实例，挂在 `context.ts`：

```ts
// main/context.ts
import { BackendManager } from './backend/manager'
import { Database } from './service/database'

export const ctx = {
  db: new Database(),
  manager: new BackendManager(),
  windows: new Map<string, BrowserWindow>(),
}
```

所有 adapter 通过 `ctx.manager.getAdapter(id)` 获取，不直接 `new`。

## 数据流：从后端消息到 UI

```
codex/claude 子进程 stdout
       │ newline-delimited JSON
       ▼
Adapter (main/backend/<id>/)
  protocol.ts → 解析 JSON 帧（Zod 校验）
  adapter.ts  → 维护状态机、驱动 AsyncIterable
  mapping.ts  → codex/claude event → TurnEvent
       │ AsyncIterable<TurnEvent>（main 内部）
       ▼
BackendManager
  路由到当前 adapter、维护 activeTurns
       │ webContents.send('backend:turnEvent', ...)
       ▼ IPC push
Pinia message store (renderer)
  累积 events → NormalizedMessage[]
       │
       ▼
Vue 组件渲染
```

**核心不变量**：从 `BackendManager` 向上的所有代码都只操作 `TurnEvent` / `NormalizedMessage`，**永远不见** `codex.*` / `claude.*` 字段。

## 何时该拆分文件

- 单个 handler 文件超过 300 行 → 按 domain 拆子文件
- 单个 Vue 组件超过 400 行 → 拆子组件或抽 composable
- Pinia store 超过 300 行 → 拆分领域（如 `session.ts` 拆出 `message.ts`）
- Adapter 超过 500 行 → 协议解析和业务分离到 `protocol.ts` / `mapping.ts`

**目标**：单文件单职责，能在不滚屏的情况下读完。
