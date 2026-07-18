---
name: catmax-conventions
description: Architecture and coding conventions for the catmax-app project (Electron + Vue3 + electron-vite). Use whenever writing, modifying, reviewing, or scaffolding code in catmax-app — including adding IPC handlers, backend adapters, Vue components, services, or touching project structure. Also use when the user references "the conventions", "项目规范", "架构规范", "编码规范". Loads architectural rules (three-process model, directory layout, IPC pattern, AgentBackend abstraction) and coding style (naming, TS strictness, Vue SFC structure, shadcn-vue usage, theme system) so all contributions stay consistent and don't drift.
---

# catmax-app 项目规范

catmax-app 是一个自用的、Electron + Vue3 桌面 code agent 客户端，通过可插拔的后端协议适配器同时支持 `codex app-server` 和 `claude code`。设计文档：`docs/superpowers/specs/2026-07-18-catmax-app-design.md`。

## 五条硬性规则（写任何代码前必读）

1. **渲染层零业务逻辑**——`src/renderer/` 绝不 import `electron`、Node 内置模块（`fs`、`child_process` 等），也不直接 import `src/main/` 或 `src/preload/`。所有系统操作走 IPC（`window.api.*`）。

2. **新增系统操作必须先定义 IPC 契约**——在 `src/shared/ipc/<domain>.ts` 加方法签名，按 `references/ipc-pattern.md` 的 6 步流程落地。Vue 组件不能直接调 Node。

3. **Adapter 必须实现 AgentBackend 接口**——所有后端协议细节（codex JSON-RPC、claude stream-json）必须在 Adapter 边界转译为 `NormalizedMessage` / `TurnEvent`。UI 永远不见后端协议原文。

4. **Zod 只用在不可信输入**——子进程消息、磁盘 JSON（settings.json）、HTTP 响应。**不要**为 IPC handler 参数加 Zod schema（TS 类型系统已经保证内部调用的类型安全）。

5. **时间用 Unix 毫秒，id 用 UUID v4**——所有 timestamp 是 `number`（毫秒），所有主键是 `string`（UUID）。

## 三层进程模型

```
src/renderer/   →  Vue3 + Pinia。零业务逻辑、零 Node API。
src/main/       →  Node.js。所有系统操作、后端通信、IPC handler。
src/shared/     →  类型契约。两进程都 import，只有类型和常量。
```

→ 完整架构、目录约定、跨层 import 规则：`references/architecture.md`

## 何时读哪个 reference

| 任务 | 读哪个文档 |
|---|---|
| 新增/修改 IPC 方法、加新 domain | `references/ipc-pattern.md` |
| 新增/修改后端适配器、改 TurnEvent、加新后端 | `references/backend-adapter.md` |
| 新增 Vue 组件、改样式、加 shadcn-vue 组件、改主题 | `references/ui-conventions.md` |
| 改目录结构、加新顶层模块、跨层 import 疑问 | `references/architecture.md` |
| 命名、格式、TS 配置、Vue SFC 结构、commit 规范 | `references/coding-style.md` |

## 常见反模式（看到立即拒绝）

```ts
// ❌ 渲染层直接调 Node
import { readFileSync } from 'fs'
const content = readFileSync('/path/to/file')

// ✅ 走 IPC
const content = await window.api.fs.readFilePreview({ workspacePath, relativePath })


// ❌ 每个 IPC handler 都包一层 Zod（重复且无价值）
ipcMain.handle('workspace.list', async (_, args) => {
  const parsed = WorkspaceListArgsSchema.parse(args)
  return db.workspaces.findAll(parsed)
})

// ✅ TS 类型从 handler 函数签名自动派生（Heckmann 模式）
export const listWorkspaces = async (): Promise<WorkspaceRecord[]> => {
  return db.workspaces.findAll()
}
handleRendererRequest('workspace.list', listWorkspaces)


// ❌ UI 见到后端协议字段
interface Message { codexTurnId: string; claudeContentBlocks: any[] }

// ✅ 用 NormalizedMessage，协议字段在 Adapter 边界蒸发
interface Message { turnId: string; textBlocks: TextBlock[]; toolBlocks: ToolBlock[] }


// ❌ 组件写具体颜色（不可主题切换、不可扩展）
<div class="bg-[#1a1a1a] text-white">

// ✅ 只引用 Layer 2 语义 token
<div class="bg-background text-foreground">
```

## 工作前提

- 默认 pnpm（包管理器），不用 npm/yarn
- 默认 TypeScript strict 模式
- 提交前跑 `pnpm lint && pnpm typecheck`（脚本在 package.json）
- commit 用 Conventional Commits（`feat:` / `fix:` / `refactor:` / `docs:` / `chore:`）
