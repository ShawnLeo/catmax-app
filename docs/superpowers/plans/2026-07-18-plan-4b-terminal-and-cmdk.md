# Plan 4b: 内置终端 + ⌘K 命令面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补全 MVP 最后两项能力——内置终端（xterm.js + node-pty）和 ⌘K 命令面板。完成后 14 项 MVP 能力全部齐备。

**Architecture:**
- **终端**：node-pty 在 main 进程 spawn shell，stdout 通过 IPC `pty:data` 推送到 renderer，renderer 的 xterm.js 实例订阅并渲染。每个终端一个 PtyProcess 实例，PtyManager 维护实例池。终端作为 RightPanel 的第三个 tab（与 Git/Files 并列）。
- **⌘K 命令面板**：renderer 全局监听 ⌘K，弹出 CommandPalette（自实现，基于 v-cmdk 模式）。命令系统是插件化的——`commandRegistry.register({ id, title, action, shortcuts? })`，各 store/component 在 onMounted 注册自己的命令。

**Tech Stack:** （已就位）Electron + Vue 3 + Pinia + Tailwind v4。**新增**：`node-pty`、`@xterm/xterm`、`@xterm/addon-fit`、`@xterm/addon-web-links`。

**设计文档参考：** `docs/superpowers/specs/2026-07-18-catmax-app-design.md`（第一章 §7、§12）

---

## 关键设计决策

### 决策 1：node-pty 需要 native rebuild（和 better-sqlite3 一样）

node-pty 是 native module，需要按 Electron ABI 编译。复用 Plan 1 的 `rebuild:native` 脚本，扩展到 `node-pty`：

```bash
electron-rebuild -f -w better-sqlite3 -w node-pty
```

### 决策 2：终端实例与 RightPanel 解耦

终端实例生命周期 > RightPanel 显示状态（用户切到 Git tab 时不能杀终端）。PtyManager 在 main 进程持久化，renderer 的 `useTerminal` composable 只控制 xterm 视图的挂载/卸载，不影响后端进程。

### 决策 3：⌘K 命令系统是插件化的

不写硬编码的命令列表。每个 store / view 通过 `commandRegistry.register(...)` 注册自己的命令。CommandPalette 只负责枚举 + 模糊搜索 + 触发。

### 决策 4：终端是 RightPanel 的第三个 tab

不破坏 Plan 4a 的 Git/Files tab 结构。Tab 切换时终端实例不销毁（v-show 而不是 v-if）。

---

## 文件结构

```
catmax-app/
├─ src/
│  ├─ shared/
│  │  └─ ipc/
│  │     └─ pty.ts                            # 🆕 pty domain 契约
│  │
│  ├─ main/
│  │  ├─ ipc/
│  │  │  ├─ register.ts                       # 📝 注册 pty domain
│  │  │  └─ domains/
│  │  │     └─ pty/                           # 🆕
│  │  │        ├─ handlers.ts                 # createTerminal/write/resize/kill
│  │  │        └─ index.ts
│  │  └─ service/
│  │     └── pty-manager.ts                   # 🆕 node-pty 实例池
│  │
│  ├─ preload/
│  │  └─ api.ts                               # 📝 暴露 pty api + pty:data 订阅
│  │
│  └─ renderer/src/
│     ├─ stores/
│     │  └─ terminal.ts                       # 🆕 终端实例状态（id 列表、当前激活）
│     ├─ composables/
│     │  └─ useTerminal.ts                    # 🆕 xterm.js 生命周期 + 数据订阅
│     ├─ lib/
│     │  └── commandRegistry.ts               # 🆕 命令注册系统
│     ├─ components/
│     │  ├─ panel/
│     │  │  ├─ RightPanel.vue                 # 📝 加 Terminal tab
│     │  │  └─ TerminalPanel.vue              # 🆕 xterm.js 挂载点
│     │  └─ command/                          # 🆕
│     │     └─ CommandPalette.vue             # ⌘K 弹窗
│     └─ views/
│        └─ ChatView.vue                      # 📝 挂 CommandPalette + 注册命令
│
└─ tests/
   └─ service/
      └── pty-manager.test.ts                 # 🆕
```

---

## Task 1: 安装依赖 + pty IPC 契约

**Files:**
- Modify: `package.json`（加 node-pty、@xterm/xterm、@xterm/addon-fit、@xterm/addon-web-links）
- Modify: `src/shared/constants.ts`（补 PTY_* channels、PUSH.PTY_DATA/PTY_EXIT）
- Modify: `package.json` 的 `rebuild:native` 脚本（加 node-pty）
- Create: `src/shared/ipc/pty.ts`

### Step 1: 安装依赖

```bash
pnpm add node-pty @xterm/xterm @xterm/addon-fit @xterm/addon-web-links
pnpm add -D @types/node-pty
```

### Step 2: 修改 rebuild:native 脚本

**Modify** `package.json` —— 把：

```json
"rebuild:native": "electron-rebuild -f -w better-sqlite3",
```

改为：

```json
"rebuild:native": "electron-rebuild -f -w better-sqlite3 -w node-pty",
```

### Step 3: 修改 shared/constants.ts

**Modify** `src/shared/constants.ts` —— 在 `IPC` 对象末尾加：

```ts
  // pty
  PTY_CREATE: 'pty.create',
  PTY_WRITE: 'pty.write',
  PTY_RESIZE: 'pty.resize',
  PTY_KILL: 'pty.kill',
```

`PUSH` 里已经有 `PTY_DATA: 'pty:data'` 和 `PTY_EXIT: 'pty:exit'`（Plan 1 加的）。

### Step 4: 创建 shared/ipc/pty.ts

Create `src/shared/ipc/pty.ts`：

```ts
export interface TerminalHandle {
  id: string
  pid: number
  initialCols: number
  initialRows: number
}

export type PtyHandlers = {
  'pty.create': (args: {
    cwd: string
    cols?: number
    rows?: number
  }) => Promise<TerminalHandle>
  'pty.write': (args: { id: string; data: string }) => Promise<void>
  'pty.resize': (args: { id: string; cols: number; rows: number }) => Promise<void>
  'pty.kill': (args: { id: string }) => Promise<void>
}

/** 推送事件 payload */
export interface PtyPushEvents {
  'pty:data': { id: string; data: string }
  'pty:exit': { id: string; exitCode: number }
}
```

### Step 5: rebuild native + typecheck + commit

```bash
pnpm rebuild:native || true
pnpm rebuild:node
pnpm typecheck && pnpm lint
git add package.json pnpm-lock.yaml src/shared/
git commit -m "feat(ipc): add pty domain contract and install xterm/node-pty deps"
```

---

## Task 2: PtyManager（node-pty 实例池）

**Files:**
- Create: `src/main/service/pty-manager.ts`
- Test: `tests/service/pty-manager.test.ts`

### Step 1: 创建 pty-manager.ts

Create `src/main/service/pty-manager.ts`：

```ts
/**
 * 终端进程管理器。
 *
 * - 用 node-pty spawn shell
 * - 每个实例一个唯一 id
 * - 通过事件回调把输出发给调用方（IPC handler 再转给 renderer）
 * - 实例退出时自动清理
 */
import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'
import { logger } from './logger'

const log = logger.domain('pty-manager')

export interface PtyCreateOptions {
  cwd?: string
  cols?: number
  rows?: number
  shell?: string
}

export interface PtyInstance {
  id: string
  pid: number
  proc: pty.IPty
}

export interface PtyCallbacks {
  onData: (id: string, data: string) => void
  onExit: (id: string, exitCode: number) => void
}

/** 默认 shell（按平台） */
function getDefaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe'
  }
  return process.env.SHELL || '/bin/zsh'
}

export class PtyManager {
  private instances = new Map<string, PtyInstance>()
  private callbacks: PtyCallbacks

  constructor(callbacks: PtyCallbacks) {
    this.callbacks = callbacks
  }

  create(opts: PtyCreateOptions = {}): PtyInstance {
    const id = randomUUID()
    const shell = opts.shell ?? getDefaultShell()
    const cols = opts.cols ?? 80
    const rows = opts.rows ?? 24

    log.info('creating terminal', id, shell)

    const proc = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols,
      rows,
      cwd: opts.cwd ?? process.cwd(),
      env: process.env as Record<string, string>,
    })

    proc.onData((data) => {
      this.callbacks.onData(id, data)
    })
    proc.onExit(({ exitCode }) => {
      log.info('terminal exited', id, exitCode)
      this.callbacks.onExit(id, exitCode)
      this.instances.delete(id)
    })

    const instance: PtyInstance = { id, pid: proc.pid, proc }
    this.instances.set(id, instance)
    return instance
  }

  write(id: string, data: string): void {
    const inst = this.instances.get(id)
    if (!inst) {
      log.warn('write: unknown id', id)
      return
    }
    inst.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const inst = this.instances.get(id)
    if (!inst) return
    try {
      inst.proc.resize(cols, rows)
    } catch (e) {
      log.warn('resize failed:', e)
    }
  }

  kill(id: string): void {
    const inst = this.instances.get(id)
    if (!inst) return
    log.info('killing terminal', id)
    try {
      inst.proc.kill()
    } catch {
      // 已退出
    }
    this.instances.delete(id)
  }

  /** 杀所有（app 退出时） */
  killAll(): void {
    for (const id of this.instances.keys()) {
      this.kill(id)
    }
  }

  has(id: string): boolean {
    return this.instances.has(id)
  }

  size(): number {
    return this.instances.size
  }
}
```

### Step 2: 写 pty-manager 单测

Create `tests/service/pty-manager.test.ts`：

```ts
// @vitest-environment node
import { describe, expect, test, afterEach } from 'vitest'
import { PtyManager } from '@main/service/pty-manager'
import { tmpdir } from 'node:os'

let manager: PtyManager

afterEach(() => {
  manager?.killAll()
})

describe('PtyManager', () => {
  test('create 返回 handle + 发出初始数据', async () => {
    const dataCalls: Array<{ id: string; data: string }> = []
    manager = new PtyManager({
      onData: (id, data) => dataCalls.push({ id, data }),
      onExit: () => {},
    })

    const handle = manager.create({ cwd: tmpdir() })
    expect(handle.id).toBeTruthy()
    expect(typeof handle.pid).toBe('number')
    expect(manager.has(handle.id)).toBe(true)
    expect(manager.size()).toBe(1)

    // 等终端启动发欢迎信息
    await new Promise((r) => setTimeout(r, 300))
    expect(dataCalls.length).toBeGreaterThan(0)
  })

  test('write 输入命令', async () => {
    const dataCalls: string[] = []
    manager = new PtyManager({
      onData: (_id, data) => dataCalls.push(data),
      onExit: () => {},
    })

    const handle = manager.create({ cwd: tmpdir() })
    await new Promise((r) => setTimeout(r, 200))

    // 输入 echo 命令
    manager.write(handle.id, "echo hello_test_1234\n")
    await new Promise((r) => setTimeout(r, 300))

    const combined = dataCalls.join('')
    expect(combined).toContain('hello_test_1234')
  })

  test('kill 清理实例', async () => {
    manager = new PtyManager({
      onData: () => {},
      onExit: () => {},
    })

    const handle = manager.create({ cwd: tmpdir() })
    expect(manager.has(handle.id)).toBe(true)

    manager.kill(handle.id)
    expect(manager.has(handle.id)).toBe(false)
  })

  test('exit 自动清理', async () => {
    const exitCalls: string[] = []
    manager = new PtyManager({
      onData: () => {},
      onExit: (id) => exitCalls.push(id),
    })

    const handle = manager.create({ cwd: tmpdir() })
    await new Promise((r) => setTimeout(r, 200))

    // 让 shell 退出
    manager.write(handle.id, 'exit\n')
    await new Promise((r) => setTimeout(r, 500))

    expect(exitCalls).toContain(handle.id)
    expect(manager.has(handle.id)).toBe(false)
  })
})
```

注意：这个测试**需要真实 shell 环境**，在 CI 受限环境可能失败。本地 macOS/Linux 应该能跑。

### Step 3: 测试 + commit

```bash
pnpm rebuild:node
pnpm test tests/service/pty-manager.test.ts
pnpm typecheck && pnpm lint
git add src/main/service/pty-manager.ts tests/service/pty-manager.test.ts
git commit -m "feat(service): add PtyManager with node-pty"
```

---

## Task 3: pty IPC domain + 挂载到 context

**Files:**
- Create: `src/main/ipc/domains/pty/{handlers,index}.ts`
- Modify: `src/main/context.ts`（挂载 PtyManager）
- Modify: `src/main/index.ts`（退出时 killAll）
- Modify: `src/main/ipc/register.ts`

### Step 1: pty handlers

Create `src/main/ipc/domains/pty/handlers.ts`：

```ts
import { ctx } from '@main/context'
import type { TerminalHandle } from '@shared/ipc/pty'

export const createTerminal = async (args: {
  cwd: string
  cols?: number
  rows?: number
}): Promise<TerminalHandle> => {
  const inst = ctx.ptyManager.create({
    cwd: args.cwd,
    cols: args.cols,
    rows: args.rows,
  })
  return {
    id: inst.id,
    pid: inst.pid,
    initialCols: args.cols ?? 80,
    initialRows: args.rows ?? 24,
  }
}

export const writeTerminal = async (args: { id: string; data: string }): Promise<void> => {
  ctx.ptyManager.write(args.id, args.data)
}

export const resizeTerminal = async (args: {
  id: string
  cols: number
  rows: number
}): Promise<void> => {
  ctx.ptyManager.resize(args.id, args.cols, args.rows)
}

export const killTerminal = async (args: { id: string }): Promise<void> => {
  ctx.ptyManager.kill(args.id)
}
```

### Step 2: pty index

Create `src/main/ipc/domains/pty/index.ts`：

```ts
import { handleRendererRequest } from '../../typed'
import type { PtyHandlers } from '@shared/ipc/pty'
import { createTerminal, killTerminal, resizeTerminal, writeTerminal } from './handlers'

export function registerPtyHandlers(): void {
  handleRendererRequest<PtyHandlers, 'pty.create'>('pty.create', createTerminal)
  handleRendererRequest<PtyHandlers, 'pty.write'>('pty.write', writeTerminal)
  handleRendererRequest<PtyHandlers, 'pty.resize'>('pty.resize', resizeTerminal)
  handleRendererRequest<PtyHandlers, 'pty.kill'>('pty.kill', killTerminal)
}

export type { PtyHandlers } from '@shared/ipc/pty'
```

### Step 3: 修改 context.ts 挂载 PtyManager

**Modify** `src/main/context.ts`：

在 import 后加：

```ts
import { PtyManager } from './service/pty-manager'
```

`Context` class 里加字段（在 `backendManager` 后）：

```ts
  readonly backendManager: BackendManager
  readonly ptyManager: PtyManager
```

constructor 里加（在 `this.backendManager = new BackendManager()` 后）：

```ts
    this.ptyManager = new PtyManager({
      onData: (id, data) => {
        this.broadcast('pty:data', { id, data })
      },
      onExit: (id, exitCode) => {
        this.broadcast('pty:exit', { id, exitCode })
      },
    })
```

### Step 4: 修改 main/index.ts 加 killAll

**Modify** `src/main/index.ts` —— 找到 `app.on('before-quit', ...)`，在 `await ctx.backendManager.dispose()` 后加：

```ts
  ctx.ptyManager.killAll()
```

### Step 5: 修改 register.ts

**Modify** `src/main/ipc/register.ts` —— 加 import 和注册：

```ts
import { registerPtyHandlers } from './domains/pty'
// ...
  registerPtyHandlers()
```

### Step 6: typecheck + commit

```bash
pnpm typecheck && pnpm lint
git add src/main/ipc/domains/pty/ src/main/context.ts src/main/index.ts src/main/ipc/register.ts
git commit -m "feat(ipc): add pty domain handlers and wire PtyManager to context"
```

---

## Task 4: preload + 终端 store + useTerminal composable

**Files:**
- Modify: `src/preload/api.ts`（加 pty + 订阅 pty:data / pty:exit）
- Create: `src/renderer/src/stores/terminal.ts`
- Create: `src/renderer/src/composables/useTerminal.ts`

### Step 1: 修改 preload/api.ts

**Modify** `src/preload/api.ts` —— 在 `fs` 块后加：

```ts
  pty: {
    create: requestMain<PtyHandlers, 'pty.create'>(IPC.PTY_CREATE),
    write: requestMain<PtyHandlers, 'pty.write'>(IPC.PTY_WRITE),
    resize: requestMain<PtyHandlers, 'pty.resize'>(IPC.PTY_RESIZE),
    kill: requestMain<PtyHandlers, 'pty.kill'>(IPC.PTY_KILL),
    onData: (cb: (payload: PtyPushEvents['pty:data']) => void) =>
      subscribeToMainEvent<PtyPushEvents, 'pty:data'>(PUSH.PTY_DATA, cb),
    onExit: (cb: (payload: PtyPushEvents['pty:exit']) => void) =>
      subscribeToMainEvent<PtyPushEvents, 'pty:exit'>(PUSH.PTY_EXIT, cb),
  },
```

文件顶部 import 加：

```ts
import type { PtyHandlers, PtyPushEvents } from '@shared/ipc/pty'
```

### Step 2: 创建 terminal store

Create `src/renderer/src/stores/terminal.ts`：

```ts
import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface TerminalInstance {
  id: string
  pid: number
  cwd: string
  createdAt: number
}

export const useTerminalStore = defineStore('terminal', () => {
  const terminals = ref<TerminalInstance[]>([])
  const activeId = ref<string | null>(null)

  async function create(cwd: string): Promise<TerminalInstance> {
    const handle = await window.api.pty.create({ cwd })
    const instance: TerminalInstance = {
      id: handle.id,
      pid: handle.pid,
      cwd,
      createdAt: Date.now(),
    }
    terminals.value.push(instance)
    activeId.value = handle.id
    return instance
  }

  async function write(id: string, data: string): Promise<void> {
    await window.api.pty.write({ id, data })
  }

  async function resize(id: string, cols: number, rows: number): Promise<void> {
    await window.api.pty.resize({ id, cols, rows })
  }

  async function kill(id: string): Promise<void> {
    await window.api.pty.kill({ id })
    removeLocal(id)
  }

  function removeLocal(id: string): void {
    terminals.value = terminals.value.filter((t) => t.id !== id)
    if (activeId.value === id) {
      activeId.value = terminals.value[0]?.id ?? null
    }
  }

  function setActive(id: string): void {
    activeId.value = id
  }

  return { terminals, activeId, create, write, resize, kill, removeLocal, setActive }
})
```

### Step 3: 创建 useTerminal composable

Create `src/renderer/src/composables/useTerminal.ts`：

```ts
import { onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useTerminalStore } from '@renderer/stores/terminal'

/**
 * 在指定 DOM 元素上挂载 xterm.js，连接到指定 terminal id。
 *
 * - 创建 Terminal + FitAddon + WebLinksAddon
 * - 订阅 pty:data（只处理本 id 的数据）
 * - 用户输入 → pty.write
 * - 容器 resize → fit + pty.resize
 */
export function useTerminal(
  containerRef: Ref<HTMLElement | null>,
  terminalId: Ref<string | null>,
) {
  const term = ref<Terminal | null>(null)
  const fitAddon = ref<FitAddon | null>(null)
  let unsubData: (() => void) | null = null
  let unsubExit: (() => void) | null = null
  let resizeObserver: ResizeObserver | null = null

  const terminalStore = useTerminalStore()

  function init() {
    if (!containerRef.value || term.value) return

    const t = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'var(--font-mono), monospace',
      theme: {
        background: '#0a0a0c',
        foreground: '#e4e4e7',
        cursor: '#e4e4e7',
      },
    })
    const fit = new FitAddon()
    t.loadAddon(fit)
    t.loadAddon(new WebLinksAddon())
    t.open(containerRef.value)
    try {
      fit.fit()
    } catch {
      // 容器还没布局好
    }

    // 用户输入 → pty
    const inputData = (data: string) => {
      const id = terminalId.value
      if (id) void terminalStore.write(id, data)
    }
    t.onData(inputData)

    // resize 处理
    const handleResize = () => {
      try {
        fit.fit()
        const id = terminalId.value
        if (id) {
          void terminalStore.resize(id, t.cols, t.rows)
        }
      } catch {
        // ignore
      }
    }

    resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(containerRef.value)

    term.value = t
    fitAddon.value = fit

    // 订阅 pty 数据
    unsubData = window.api.pty.onData(({ id, data }) => {
      if (id === terminalId.value) {
        t.write(data)
      }
    })
    unsubExit = window.api.pty.onExit(({ id, exitCode }) => {
      if (id === terminalId.value) {
        t.write(`\r\n[process exited with code ${exitCode}]\r\n`)
        terminalStore.removeLocal(id)
      }
    })
  }

  function dispose() {
    resizeObserver?.disconnect()
    resizeObserver = null
    unsubData?.()
    unsubData = null
    unsubExit?.()
    unsubExit = null
    term.value?.dispose()
    term.value = null
    fitAddon.value = null
  }

  onMounted(() => {
    init()
  })

  onUnmounted(() => {
    dispose()
  })

  // terminalId 变化时重新初始化（保持同一个 xterm 实例，只切数据源）
  watch(terminalId, () => {
    // 不需要重新 init，因为 onData 用的是 ref，自动响应
  })

  return { term, fitAddon }
}
```

### Step 4: typecheck + commit

```bash
pnpm typecheck && pnpm lint
git add src/preload/api.ts src/renderer/src/stores/terminal.ts src/renderer/src/composables/useTerminal.ts
git commit -m "feat(renderer): add terminal store + useTerminal composable with xterm.js"
```

---

## Task 5: TerminalPanel + RightPanel 集成

**Files:**
- Create: `src/renderer/src/components/panel/TerminalPanel.vue`
- Modify: `src/renderer/src/components/panel/RightPanel.vue`（加 Terminal tab）

### Step 1: 创建 TerminalPanel

Create `src/renderer/src/components/panel/TerminalPanel.vue`：

```vue
<template>
  <div class="h-full flex flex-col">
    <!-- 顶部：终端 tab 切换 + 新建按钮 -->
    <div class="flex items-center border-b border-border bg-muted/30">
      <div class="flex-1 flex overflow-x-auto">
        <button
          v-for="t in terminalStore.terminals"
          :key="t.id"
          :class="[
            'px-2 py-1 text-xs whitespace-nowrap border-r border-border',
            terminalStore.activeId === t.id
              ? 'bg-background text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          ]"
          @click="terminalStore.setActive(t.id)"
        >
          <TerminalIcon class="w-3 h-3 inline-block mr-1" />
          shell-{{ t.pid }}
        </button>
      </div>
      <button
        class="px-2 py-1 text-muted-foreground hover:text-foreground"
        title="新建终端"
        @click="createTerminal"
      >
        <PlusIcon class="w-3 h-3" />
      </button>
    </div>

    <!-- xterm 挂载点 -->
    <div ref="container" class="flex-1 bg-terminal-background overflow-hidden" />

    <!-- 没有 terminal 时的提示 -->
    <div
      v-if="terminalStore.terminals.length === 0"
      class="absolute inset-0 top-8 flex items-center justify-center text-xs text-muted-foreground pointer-events-none"
    >
      点击 + 创建终端
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { TerminalIcon, PlusIcon } from 'lucide-vue-next'
import { useTerminal } from '@renderer/composables/useTerminal'
import { useTerminalStore } from '@renderer/stores/terminal'
import { useWorkspaceStore } from '@renderer/stores/workspace'

const terminalStore = useTerminalStore()
const workspaceStore = useWorkspaceStore()
const container = ref<HTMLElement | null>(null)

const activeTerminalId = computed(() => terminalStore.activeId)

const { term } = useTerminal(container, activeTerminalId)

async function createTerminal(): Promise<void> {
  const cwd = workspaceStore.currentWorkspace?.path ?? process.cwd()
  await terminalStore.create(cwd)
}

// 首次进入时如果没终端，自动创建一个
onMounted(async () => {
  if (terminalStore.terminals.length === 0) {
    await createTerminal()
  }
})
</script>
```

### Step 2: 修改 RightPanel.vue 加 Terminal tab

**Modify** `src/renderer/src/components/panel/RightPanel.vue` —— 在 `tabs` 数组加 terminal：

把 tabs 改成（在 files 后面追加 terminal 项）：

```ts
const tabs = computed(() => [
  {
    id: 'git' as const,
    label: 'Git',
    icon: GitBranchIcon,
    badge: gitStore.totalChanges > 0 ? gitStore.totalChanges : undefined,
  },
  {
    id: 'files' as const,
    label: 'Files',
    icon: FolderTreeIcon,
    badge: undefined,
  },
  {
    id: 'terminal' as const,
    label: 'Terminal',
    icon: TerminalIcon,
    badge: undefined,
  },
])
```

`activeTab` type 改：

```ts
type TabId = 'git' | 'files' | 'terminal'
```

template 里加 Terminal 分支（在 FileTree 后）：

```vue
      <TerminalPanel v-else-if="activeTab === 'terminal'" />
```

script setup 顶部加 import：

```ts
import { TerminalIcon } from 'lucide-vue-next'
import TerminalPanel from './TerminalPanel.vue'
```

### Step 3: typecheck + lint + commit

```bash
pnpm typecheck && pnpm lint
git add src/renderer/src/components/panel/TerminalPanel.vue src/renderer/src/components/panel/RightPanel.vue
git commit -m "feat(panel): add Terminal tab with xterm.js + node-pty"
```

---

## Task 6: 命令注册系统 + ⌘K CommandPalette

**Files:**
- Create: `src/renderer/src/lib/commandRegistry.ts`
- Create: `src/renderer/src/components/command/CommandPalette.vue`
- Create: `src/renderer/src/composables/useShortcut.ts`
- Modify: `src/renderer/src/App.vue`（挂 CommandPalette）

### Step 1: 创建 commandRegistry

Create `src/renderer/src/lib/commandRegistry.ts`：

```ts
/**
 * 命令注册系统。
 *
 * 任意模块（store、view、组件）可以注册命令：
 *   commandRegistry.register({
 *     id: 'workspace.refresh',
 *     title: '刷新工作区',
 *     category: 'Workspace',
 *     keywords: ['workspace', 'refresh'],
 *     action: () => { ... },
 *   })
 *
 * CommandPalette 模糊搜索 title + keywords。
 */
import { reactive } from 'vue'

export interface Command {
  id: string
  title: string
  category?: string
  keywords?: string[]
  shortcut?: string // 显示用，如 '⌘K'
  action: () => void | Promise<void>
}

class CommandRegistry {
  private commands = reactive(new Map<string, Command>())

  register(cmd: Command): () => void {
    this.commands.set(cmd.id, cmd)
    return () => {
      this.commands.delete(cmd.id)
    }
  }

  unregister(id: string): void {
    this.commands.delete(id)
  }

  getAll(): Command[] {
    return Array.from(this.commands.values())
  }

  /** 模糊搜索（简单实现：title/keywords 包含 query 任意词） */
  search(query: string): Command[] {
    if (!query.trim()) {
      return this.getAll().sort((a, b) => a.title.localeCompare(b.title))
    }
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const scored = this.getAll()
      .map((cmd) => {
        const haystack = (
          cmd.title +
          ' ' +
          (cmd.category ?? '') +
          ' ' +
          (cmd.keywords ?? []).join(' ')
        ).toLowerCase()
        let score = 0
        for (const term of terms) {
          if (haystack.includes(term)) score += 1
          if (cmd.title.toLowerCase().startsWith(term)) score += 2
        }
        return { cmd, score }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
    return scored.map((x) => x.cmd)
  }

  /** 触发命令 */
  async run(id: string): Promise<void> {
    const cmd = this.commands.get(id)
    if (cmd) {
      await cmd.action()
    }
  }
}

export const commandRegistry = new CommandRegistry()
```

### Step 2: 创建 useShortcut composable

Create `src/renderer/src/composables/useShortcut.ts`：

```ts
import { onMounted, onUnmounted } from 'vue'

/**
 * 全局快捷键 composable。
 * 用法：
 *   useShortcut('mod+k', () => openPalette())
 *
 * 'mod' 自动映射为 macOS 的 Cmd / 其他的 Ctrl。
 */
export function useShortcut(shortcut: string, callback: () => void): void {
  const handler = (e: KeyboardEvent) => {
    const parts = shortcut.toLowerCase().split('+')
    const wantMod = parts.includes('mod') || parts.includes('cmd') || parts.includes('ctrl')
    const wantShift = parts.includes('shift')
    const wantAlt = parts.includes('alt')
    const key = parts[parts.length - 1]

    const isMod = e.metaKey || e.ctrlKey
    if (wantMod !== isMod) return
    if (wantShift !== e.shiftKey) return
    if (wantAlt !== e.altKey) return
    if (e.key.toLowerCase() !== key) return

    e.preventDefault()
    callback()
  }

  onMounted(() => window.addEventListener('keydown', handler))
  onUnmounted(() => window.removeEventListener('keydown', handler))
}
```

### Step 3: 创建 CommandPalette

Create `src/renderer/src/components/command/CommandPalette.vue`：

```vue
<template>
  <div
    v-if="visible"
    class="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/50"
    @click.self="close"
  >
    <div class="bg-popover text-popover-foreground rounded-lg shadow-xl w-full max-w-xl mx-4 overflow-hidden border border-border">
      <!-- 搜索框 -->
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
        <SearchIcon class="w-4 h-4 text-muted-foreground" />
        <input
          ref="inputEl"
          v-model="query"
          placeholder="输入命令名或关键词..."
          class="flex-1 bg-transparent text-sm focus:outline-none text-foreground placeholder:text-muted-foreground"
          @keydown.esc="close"
          @keydown.enter="runSelected"
          @keydown.arrow-down="selectNext"
          @keydown.arrow-up="selectPrev"
        />
        <kbd class="text-xs text-muted-foreground px-1.5 py-0.5 border border-border rounded">ESC</kbd>
      </div>

      <!-- 命令列表 -->
      <div v-if="results.length > 0" class="max-h-80 overflow-y-auto py-1">
        <button
          v-for="(cmd, i) in results"
          :key="cmd.id"
          :class="[
            'w-full flex items-center gap-3 px-4 py-2 text-left',
            i === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
          ]"
          @click="run(cmd)"
        >
          <div class="flex-1 min-w-0">
            <div class="text-sm text-foreground truncate">{{ cmd.title }}</div>
            <div v-if="cmd.category" class="text-xs text-muted-foreground">{{ cmd.category }}</div>
          </div>
          <kbd v-if="cmd.shortcut" class="text-xs text-muted-foreground">{{ cmd.shortcut }}</kbd>
        </button>
      </div>
      <div v-else class="py-8 text-center text-sm text-muted-foreground">
        没有匹配的命令
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { SearchIcon } from 'lucide-vue-next'
import { commandRegistry, type Command } from '@renderer/lib/commandRegistry'

const visible = defineModel<boolean>('visible', { default: false })

const query = ref('')
const selectedIndex = ref(0)
const inputEl = ref<HTMLInputElement | null>(null)

const results = computed<Command[]>(() => commandRegistry.search(query.value))

watch(visible, async (v) => {
  if (v) {
    query.value = ''
    selectedIndex.value = 0
    await nextTick()
    inputEl.value?.focus()
  }
})

watch(query, () => {
  selectedIndex.value = 0
})

function close(): void {
  visible.value = false
}

async function run(cmd: Command): Promise<void> {
  close()
  await commandRegistry.run(cmd.id)
}

async function runSelected(): Promise<void> {
  if (results.value[selectedIndex.value]) {
    await run(results.value[selectedIndex.value]!)
  }
}

function selectNext(): void {
  if (selectedIndex.value < results.value.length - 1) {
    selectedIndex.value++
  }
}

function selectPrev(): void {
  if (selectedIndex.value > 0) {
    selectedIndex.value--
  }
}

function onKey(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    visible.value = !visible.value
  }
}

onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>
```

### Step 4: 修改 App.vue 挂 CommandPalette

**Modify** `src/renderer/src/App.vue` —— 在 `<RouterView />` 后加：

```vue
    <RouterView />

    <CommandPalette v-model:visible="commandPaletteVisible" />
```

`<script setup>` 加：

```ts
import { ref } from 'vue'
import CommandPalette from '@renderer/components/command/CommandPalette.vue'

const commandPaletteVisible = ref(false)
```

### Step 5: typecheck + lint + commit

```bash
pnpm typecheck && pnpm lint
git add src/renderer/src/lib/commandRegistry.ts src/renderer/src/composables/useShortcut.ts src/renderer/src/components/command/ src/renderer/src/App.vue
git commit -m "feat(command): add command registry and ⌘K CommandPalette"
```

---

## Task 7: 注册 MVP 命令集

**Files:**
- Create: `src/renderer/src/lib/commands.ts`（集中注册默认命令）
- Modify: `src/renderer/src/main.ts`（import commands 触发注册）

### Step 1: 创建 commands.ts

Create `src/renderer/src/lib/commands.ts`：

```ts
/**
 * 默认命令注册。
 *
 * 在 main.ts 引入此文件即可触发注册（副作用模块）。
 * 各命令通过 pinia store 调用实际逻辑。
 */
import { commandRegistry } from './commandRegistry'

export async function registerDefaultCommands(): Promise<void> {
  // 动态 import 避免循环依赖
  const { useWorkspaceStore } = await import('@renderer/stores/workspace')
  const { useBackendStore } = await import('@renderer/stores/backend')
  const { useSessionStore } = await import('@renderer/stores/session')
  const { useUiStore } = await import('@renderer/stores/ui')
  const router = (await import('@renderer/router')).router

  // 这里不能用 useXxxStore（需要在 setup 内），改成在 action 里调
  commandRegistry.register({
    id: 'app.go-welcome',
    title: '回到首页',
    category: 'Navigation',
    keywords: ['home', 'welcome', 'back'],
    action: () => router.push('/'),
  })

  commandRegistry.register({
    id: 'app.go-settings',
    title: '打开设置',
    category: 'Navigation',
    keywords: ['settings', 'preference', 'config'],
    shortcut: '⌘,',
    action: () => router.push('/settings'),
  })

  commandRegistry.register({
    id: 'workspace.add',
    title: '添加工作区',
    category: 'Workspace',
    keywords: ['workspace', 'add', 'folder', 'open'],
    action: async () => {
      const ws = useWorkspaceStore()
      const result = await window.api.system.openDialog({
        title: '选择工作区文件夹',
        properties: ['openDirectory'],
      })
      if (!result.canceled && result.filePaths.length > 0) {
        await ws.add(result.filePaths[0]!)
        router.push('/chat')
      }
    },
  })

  commandRegistry.register({
    id: 'session.new',
    title: '新建会话',
    category: 'Session',
    keywords: ['session', 'new', 'chat'],
    action: () => {
      const s = useSessionStore()
      s.setCurrent('')
      router.push('/chat')
    },
  })

  commandRegistry.register({
    id: 'backend.switch-codex',
    title: '切换到 Codex 后端',
    category: 'Backend',
    keywords: ['backend', 'switch', 'codex', 'openai'],
    action: async () => {
      const b = useBackendStore()
      await b.switchTo('codex')
    },
  })

  commandRegistry.register({
    id: 'backend.switch-claude',
    title: '切换到 Claude 后端',
    category: 'Backend',
    keywords: ['backend', 'switch', 'claude', 'anthropic'],
    action: async () => {
      const b = useBackendStore()
      await b.switchTo('claude')
    },
  })

  commandRegistry.register({
    id: 'backend.refresh',
    title: '刷新后端状态',
    category: 'Backend',
    keywords: ['backend', 'refresh', 'status'],
    action: async () => {
      const b = useBackendStore()
      await b.refresh()
    },
  })
}

// 不立即调，由 main.ts 控制
export { commandRegistry }
```

### Step 2: 修改 main.ts 触发注册

**Modify** `src/renderer/src/main.ts` —— 在 `app.mount('#app')` 后加：

```ts
import { registerDefaultCommands } from './lib/commands'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')

// 注册默认命令
void registerDefaultCommands()
```

### Step 3: typecheck + lint + commit

```bash
pnpm typecheck && pnpm lint
git add src/renderer/src/lib/commands.ts src/renderer/src/main.ts
git commit -m "feat(command): register default commands (navigation/workspace/session/backend)"
```

---

## Task 8: 集成验证 + smoke test

**Files:**
- Run: 全套测试 + typecheck + lint + dev 启动
- Create: `docs/superpowers/plans/2026-07-18-plan-4b-smoke-test.md`

### Step 1: 全套自动化测试

```bash
pnpm rebuild:node
pnpm typecheck
pnpm lint
pnpm test
```

Expected: 148 + Plan 4b 新增（pty-manager ~4 tests）= 152+ tests。

### Step 2: production build

```bash
pnpm rebuild:native
pnpm build
```

### Step 3: dev 启动 + 走查

```bash
pnpm dev
```

可视化验证：

1. ✅ RightPanel 出现 Terminal tab（第三个）
2. ✅ 切到 Terminal tab → 自动创建一个终端，看到 shell 提示符
3. ✅ 输入 `ls` + Enter → 看到文件列表
4. ✅ 点 + 按钮 → 新建第二个终端
5. ✅ 切换终端 tab → 数据不混
6. ✅ 按 ⌘K → CommandPalette 弹出
7. ✅ 输入"工作区" → 模糊匹配"添加工作区"
8. ✅ 回车 → 触发对应 action（如弹文件夹选择器）
9. ✅ Esc 关闭 CommandPalette

### Step 4: 写 smoke test 文档

Create `docs/superpowers/plans/2026-07-18-plan-4b-smoke-test.md`：

```markdown
# Plan 4b Smoke Test 端到端验证清单

## 自动化验证（已通过）

- [ ] `pnpm typecheck` 0 errors
- [ ] `pnpm lint` 0 errors
- [ ] `pnpm test` 152+ tests passing
- [ ] `pnpm build` production 成功

## 可视化验证

### 终端
- [ ] RightPanel 第三个 tab "Terminal" 可见
- [ ] 切到 Terminal → 自动创建终端
- [ ] 看到 shell 提示符（zsh / bash）
- [ ] 输入 `ls` + Enter 看到输出
- [ ] 鼠标滚动有效
- [ ] 调整 RightPanel 宽度 → 终端列数自适应
- [ ] 点 + 按钮新建终端
- [ ] 切换 tab 时数据隔离
- [ ] 链接可点击（addon-web-links）

### ⌘K 命令面板
- [ ] 按 ⌘K 弹出 CommandPalette
- [ ] 自动 focus 输入框
- [ ] 列出所有命令（按字母序）
- [ ] 输入"工作区" → 匹配"添加工作区"
- [ ] ↑↓ 选择命令
- [ ] 回车触发
- [ ] Esc 关闭
- [ ] 点击外部关闭

### 命令集
- [ ] "回到首页" 工作
- [ ] "打开设置" 工作
- [ ] "添加工作区" 弹文件夹选择器
- [ ] "新建会话" 工作
- [ ] "切换到 Codex/Claude 后端" 工作
- [ ] "刷新后端状态" 工作

## 总结

Plan 4b 完成度：8/8 tasks ✅。

至此 MVP 全部 14 项能力齐备。下一步是打磨、性能优化、Plan 5+ 的高级功能。
```

### Step 5: 提交

```bash
git add docs/superpowers/plans/2026-07-18-plan-4b-smoke-test.md
git commit -m "docs: add Plan 4b smoke test checklist"
```

---

## Plan 4b 完成标志

- ✅ 内置终端（xterm.js + node-pty，多实例、resize、web-links）
- ✅ ⌘K 命令面板（命令注册系统、模糊搜索、键盘导航）
- ✅ 7 个默认命令（导航/工作区/会话/后端切换）
- ✅ RightPanel 三 tab：Git / Files / Terminal
- ✅ 152+ tests 通过

---

## 自检

**1. Spec 覆盖**：Plan 4b 完成设计文档 §7（⌘K）+ §12（终端）。**14 项 MVP 能力全部齐备**。

**2. 占位符扫描**：无 TBD/TODO。

**3. 类型一致性**：
- `PtyHandlers` / `PtyPushEvents` 在 shared/ipc/pty.ts
- `TerminalHandle` 包含 pid / cols / rows
- `Command` 接口含 id/title/category/keywords/shortcut/action

**4. 已知简化**：
- 终端测试需要真实 shell，CI 环境可能失败
- 命令系统的快捷键是显示用，实际触发由全局 keydown 监听（不在 registry 里集中绑定）
- 终端不持久化（重启 App 后丢失），Plan 5+ 加
