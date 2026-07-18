# IPC 模式规范

catmax-app 的 IPC 采用 **Heckmann 模式**：handler 函数签名即契约，类型自动派生到 renderer。

## 核心思想

```
传统模式（错）：
  ipcMain.handle('workspace.list', handler)  ← 字符串 + 无类型
  
Heckmann 模式（对）：
  export const listWorkspaces = async (): Promise<WorkspaceRecord[]> => { ... }
                                                    ↑ 签名即契约
  handleRendererRequest('workspace.list', listWorkspaces)
                                                    ↑ 自动从函数派生类型
  window.api.workspace.list(): Promise<WorkspaceRecord[]>
                                                    ↑ renderer 调用端类型安全
```

改 handler 签名 → renderer 立刻编译报错 → **契约永不漂移**。

## 类型化 IPC 基础类

`src/main/ipc/typed.ts` —— 项目核心基础设施（一次性写好，后续不重复）：

```ts
import { ipcMain, type IpcMainInvokeEvent } from 'electron'

// 事件映射类型（key = 方法名，value = handler 函数签名）
type IpcHandleMap = {
  [K in string]: (...args: any[]) => any
}

// 推送事件映射（key = 事件名，value = payload 类型）
type IpcPushMap = {
  [K in string]: unknown
}

// 主进程注册器
export class TypedIpcMain<Handlers extends IpcHandleMap> {
  private registered = new Set<string>()

  handle<K extends keyof Handlers & string>(
    channel: K,
    handler: (
      event: IpcMainInvokeEvent,
      ...args: Parameters<Handlers[K]>
    ) => ReturnType<Handlers[K]> | Promise<ReturnType<Handlers[K]>>,
  ): void {
    if (this.registered.has(channel)) {
      throw new Error(`IPC handler "${channel}" already registered`)
    }
    this.registered.add(channel)
    ipcMain.handle(channel, handler)
  }

  // 主→渲染推送
  push<K extends keyof PushEvents & string>(
    webContents: Electron.WebContents,
    channel: K,
    ...args: PushEvents[K] extends unknown[] ? PushEvents[K] : [PushEvents[K]]
  ): void {
    webContents.send(channel, ...args)
  }
}

// 全局实例（types 从各 domain 聚合而来）
export const typedIpc = new TypedIpcMain<AllHandlers>()
```

## 新增 IPC 方法的标准 6 步流程

以新增 `workspace.export` 为例。

### Step 1: 在 `shared/ipc/<domain>.ts` 定义契约

```ts
// src/shared/ipc/workspace.ts

export interface WorkspaceRecord {
  id: string
  path: string
  name: string
  preferredEditor: EditorId | null
  lastOpenedAt: number
  createdAt: number
}

// 函数签名即契约
export async function listWorkspaces(): Promise<WorkspaceRecord[]> { /* impl in main */ }
export async function addWorkspace(args: { path: string; name?: string }): Promise<WorkspaceRecord> { /* ... */ }
export async function removeWorkspace(args: { id: string }): Promise<void> { /* ... */ }

// 🆕 新增
export async function exportWorkspace(args: {
  id: string
  format: 'json' | 'markdown'
}): Promise<{ blob: Uint8Array; filename: string }> { /* impl in main */ }
```

### Step 2: 在 `main/ipc/domains/<domain>/handlers.ts` 实现

```ts
// src/main/ipc/domains/workspace/handlers.ts

import { ctx } from '@main/context'
import type { WorkspaceRecord } from '@shared/ipc/workspace'

// ✅ 实现 + 类型导出（让 index.ts 聚合）
export const listWorkspaces = async (): Promise<WorkspaceRecord[]> => {
  return ctx.db.workspaces.findAll()
}

export const addWorkspace = async (args: { path: string; name?: string }): Promise<WorkspaceRecord> => {
  return ctx.db.workspaces.insert(args)
}

export const removeWorkspace = async (args: { id: string }): Promise<void> => {
  await ctx.db.workspaces.delete(args.id)
}

// 🆕 新增
export const exportWorkspace = async (args: {
  id: string
  format: 'json' | 'markdown'
}): Promise<{ blob: Uint8Array; filename: string }> => {
  const ws = await ctx.db.workspaces.findById(args.id)
  if (!ws) throw new WorkspaceNotFoundError(args.id)
  
  const content = args.format === 'json'
    ? JSON.stringify(ws, null, 2)
    : `# ${ws.name}\n\nPath: ${ws.path}\n...`
  
  return {
    blob: new TextEncoder().encode(content),
    filename: `${ws.name}.${args.format === 'json' ? 'json' : 'md'}`,
  }
}
```

### Step 3: 在 `main/ipc/domains/<domain>/index.ts` 注册

```ts
// src/main/ipc/domains/workspace/index.ts

import { typedIpc } from '@main/ipc/typed'
import { listWorkspaces, addWorkspace, removeWorkspace, exportWorkspace } from './handlers'

export const registerWorkspaceHandlers = (): void => {
  typedIpc.handle('workspace.list',         (_e) => listWorkspaces())
  typedIpc.handle('workspace.add',          (_e, args) => addWorkspace(args))
  typedIpc.handle('workspace.remove',       (_e, args) => removeWorkspace(args))
  // 🆕 新增
  typedIpc.handle('workspace.export',       (_e, args) => exportWorkspace(args))
}

// 聚合类型导出（给 AllHandlers 用）
export type WorkspaceHandlers = {
  'workspace.list':    typeof listWorkspaces
  'workspace.add':     typeof addWorkspace
  'workspace.remove':  typeof removeWorkspace
  'workspace.export':  typeof exportWorkspace
}
```

### Step 4: 在 `main/ipc/register.ts` 统一注册

```ts
// src/main/ipc/register.ts

import { app } from 'electron'
import { registerWorkspaceHandlers } from './domains/workspace'
import { registerSessionHandlers } from './domains/session'
// ... 其他 domain

export async function registerAllHandlers(): Promise<void> {
  registerWorkspaceHandlers()
  registerSessionHandlers()
  // ... 其他
}

// 聚合所有 handler 类型
export type AllHandlers =
  & WorkspaceHandlers
  & SessionHandlers
  & BackendHandlers
  & GitHandlers
  & FsHandlers
  & PtyHandlers
  & CredentialHandlers
  & SettingsHandlers
  & SystemHandlers
```

在 `main/index.ts` 调用：

```ts
// src/main/index.ts
app.whenReady().then(async () => {
  await ctx.db.migrate()
  await registerAllHandlers()
  await ctx.manager.initialize()
  createWindow()
})
```

### Step 5: 在 `preload/api.ts` 暴露给渲染层

```ts
// src/preload/api.ts

import { ipcRenderer } from 'electron'
import type { AllHandlers } from '@main/ipc/register'

type HandlerKey = keyof AllHandlers

// 工具函数：从 channel 名派生调用函数
function requestMain<K extends HandlerKey>(channel: K) {
  return (...args: Parameters<AllHandlers[K]>) =>
    ipcRenderer.invoke(channel, ...args) as Promise<ReturnType<AllHandlers[K]>>
}

function onMainEvent<K extends keyof PushEvents & string>(
  channel: K,
): (cb: (payload: PushEvents[K]) => void) => () => void {
  return (cb) => {
    const handler = (_e: unknown, payload: PushEvents[K]) => cb(payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

export const api = {
  workspace: {
    list:    requestMain('workspace.list'),
    add:     requestMain('workspace.add'),
    remove:  requestMain('workspace.remove'),
    // 🆕 新增
    export:  requestMain('workspace.export'),
  },
  // ... 其他 domain
}

export type Api = typeof api
```

### Step 6: 在 `preload/index.ts` 注入到 window

```ts
// src/preload/index.ts

import { contextBridge } from 'electron'
import { api } from './api'

contextBridge.exposeInMainWorld('api', api)
```

```ts
// src/renderer/src/env.d.ts

declare global {
  interface Window {
    api: import('@preload/api').Api
  }
}
```

### 渲染层使用

```ts
// 任意 Vue 组件 / store
const result = await window.api.workspace.export({
  id: 'ws_123',
  format: 'json',
})
// result 类型自动为 { blob: Uint8Array; filename: string }
```

**改 handler 签名 → renderer 立刻编译报错**，这就是类型派生的威力。

## 主→渲染推送（流式事件）

适用场景：流式输出、终端数据、状态变化通知。

### 注册推送事件类型

```ts
// src/main/ipc/domains/backend/events.ts

export type BackendPushEvents = {
  'backend:turnEvent':    { turnId: string; event: TurnEvent }
  'backend:switched':     { id: BackendId }
  'backend:statusChanged':{ status: BackendStatus }
}
```

聚合到全局 `PushEvents`：

```ts
// src/main/ipc/register.ts
export type PushEvents =
  & BackendPushEvents
  & PtyPushEvents   // 'pty:data' / 'pty:exit'
  // ... 其他
```

### 主进程推送

```ts
// src/main/backend/manager.ts
import { ctx } from '@main/context'

class BackendManager {
  private emitTurnEvent(turnId: string, event: TurnEvent): void {
    for (const wc of ctx.windows.values()) {
      if (!wc.isDestroyed()) {
        wc.send('backend:turnEvent', { turnId, event })
      }
    }
  }
}
```

### 渲染层订阅

```ts
// src/renderer/src/ipc/index.ts
export function onBackendTurnEvent(
  cb: (payload: { turnId: string; event: TurnEvent }) => void,
): () => void {
  return window.api.onBackendTurnEvent(cb)  // 来自 preload/api.ts 的 onMainEvent
}
```

```ts
// src/renderer/src/stores/message.ts
import { onBackendTurnEvent } from '@renderer/ipc'

let unsubscribe: (() => void) | null = null

function startListening() {
  unsubscribe = onBackendTurnEvent(({ turnId, event }) => {
    switch (event.type) {
      case 'text_delta':      appendText(turnId, event.text); break
      case 'tool_call_started': addToolBlock(turnId, event); break
      case 'turn_completed':   finalizeTurn(turnId, event); break
    }
  })
}

function stopListening() {
  unsubscribe?.()
  unsubscribe = null
}
```

**规则**：
- 调用方负责订阅生命周期（onMounted 订阅、onUnmounted 取消）
- 主进程推送前检查 `webContents.isDestroyed()`（窗口可能已关闭）
- 大流量推送（pty:data、backend:turnEvent）必须用 send，**不用 invoke**

## 反模式（看到立即拒绝）

### ❌ 散落的 `ipcMain.handle`

```ts
// 散落在多个文件、无统一类型
// src/main/some-feature.ts
ipcMain.handle('something', (e, args) => { ... })

// src/main/another-feature.ts
ipcMain.handle('other', (e, args) => { ... })
```

**正确**：所有 handler 通过 `registerXxxHandlers` 注册到 `register.ts`。

### ❌ 为 IPC 参数加 Zod schema

```ts
// 浪费 + 重复（TS 已经保证类型）
const ArgsSchema = z.object({ id: z.string() })
ipcMain.handle('workspace.remove', (e, args) => {
  const parsed = ArgsSchema.parse(args)
  // ...
})
```

**正确**：类型从 handler 签名自动派生。Zod 只用于不可信外部输入。

### ❌ renderer 直接 import `electron`

```ts
import { ipcRenderer } from 'electron'  // ❌
await ipcRenderer.invoke('workspace.list')
```

**正确**：用 `window.api.*`（preload 已暴露）。

### ❌ 用 `invoke` 做高频流式推送

```ts
// ❌ 每次输出都创建 Promise，开销大
for (const chunk of chunks) {
  await renderer.invoke('backend:turnEvent', chunk)
}
```

**正确**：主进程用 `webContents.send`，renderer 用 `onMainEvent` 订阅。

### ❌ 方法名不带 domain 前缀

```ts
'getList'  // ❌ 哪个 domain？
'workspace:get-list'  // ❌ 用了斜杠（与推送事件混淆）
```

**正确**：`'workspace.list'`（点分）。

## 何时该新建 domain

| 信号 | 处理 |
|---|---|
| 新增的能力与现有 8 个 domain 都不相关 | 新建 domain |
| 一个 domain 的方法数 > 12 | 考虑拆分 |
| handler 需要访问不同的 service 子集 | 不需要拆，service 在 `ctx` 共享 |
| 方法只是同一能力的不同参数 | 不新建，加方法即可 |

**9 个 domain**：`workspace` / `session` / `backend` / `git` / `fs` / `pty` / `credential` / `settings` / `system`。
