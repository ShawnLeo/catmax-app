<template>
  <div ref="rootRef" class="relative h-full flex flex-col">
    <!--
      顶部 tab 栏：[终端] 标题 + 终端 tab（可关闭/双击重命名）+ 新建按钮。
      黑白灰语义 token，无彩色。tab 圆角化，hover 显关闭按钮。
    -->
    <div class="flex items-center gap-1.5 px-3 py-2 border-b border-border bg-muted/30">
      <!-- "终端" 标题字样 -->
      <span
        class="text-sm font-medium text-muted-foreground px-2 py-1 border-r border-border mr-1 shrink-0"
      >
        终端
      </span>

      <!-- 终端 tab 列表 -->
      <div class="flex-1 flex items-center gap-1 overflow-x-auto">
        <div
          v-for="t in terminalStore.terminals"
          :key="t.id"
          :class="[
            'group flex items-center gap-1.5 pl-3 pr-2 py-1 rounded-md text-sm whitespace-nowrap transition-colors shrink-0',
            terminalStore.activeId === t.id
              ? 'bg-background text-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
          ]"
          @click="terminalStore.setActive(t.id)"
        >
          <TerminalIcon class="w-3 h-3 shrink-0" />

          <!-- 重命名 input / 名称 -->
          <input
            v-if="renamingId === t.id"
            :ref="(el) => setRenameInput(el as HTMLInputElement | null)"
            v-model="renameValue"
            class="bg-transparent border-none outline-none text-sm text-foreground max-w-[120px] p-0"
            @click.stop
            @keydown.enter="commitRename(t.id)"
            @keydown.escape="cancelRename"
            @blur="commitRename(t.id)"
          />
          <span
            v-else
            class="max-w-[120px] truncate"
            :title="`双击重命名：${t.name}`"
            @dblclick.stop="startRename(t.id, t.name)"
          >
            {{ t.name }}
          </span>

          <!-- 关闭按钮（hover 显示） -->
          <button
            class="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-opacity"
            title="关闭终端"
            @click.stop="terminalStore.kill(t.id)"
          >
            <XIcon class="w-3 h-3" />
          </button>
        </div>
      </div>

      <!-- 新建终端按钮 -->
      <button
        class="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted shrink-0"
        title="新建终端"
        @click="createTerminal"
      >
        <PlusIcon class="w-3.5 h-3.5" />
      </button>
    </div>

    <!--
      终端区：相对定位容器，每个终端一个 absolute 挂载 div（v-show 控制显隐，不卸载）。
      每个终端有独立 xterm 实例——切换 tab 切显示对应实例，后台终端输出持续写入不丢失。
    -->
    <div class="relative flex-1 overflow-hidden bg-[#0a0a0c]">
      <div
        v-for="t in terminalStore.terminals"
        :key="t.id"
        :ref="(el) => setMountEl(t.id, el as HTMLElement | null)"
        v-show="terminalStore.activeId === t.id"
        class="absolute inset-0 p-2"
      />
    </div>

    <!-- 没有 terminal 时的提示 -->
    <div
      v-if="terminalStore.terminals.length === 0"
      class="absolute inset-0 top-10 flex items-center justify-center text-xs text-muted-foreground pointer-events-none"
    >
      点击 + 创建终端
    </div>
  </div>
</template>

<script setup lang="ts">
import { useTerminalStore } from '@renderer/stores/terminal'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { PlusIcon, TerminalIcon, XIcon } from 'lucide-vue-next'
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

const terminalStore = useTerminalStore()
const workspaceStore = useWorkspaceStore()

// —— xterm 多实例管理 ——
// 每个终端 id 对应一个 xterm 实例 + fit addon；DOM 挂载点单独存。
interface TermInstance {
  term: Terminal
  fit: FitAddon
}
const instances = new Map<string, TermInstance>()
const mountEls = new Map<string, HTMLElement>()
const rootRef = ref<HTMLElement | null>(null)

/** 模板里每个终端 div 的 ref 回调——记录/清理挂载点 DOM。 */
function setMountEl(id: string, el: HTMLElement | null): void {
  if (el) {
    // 新挂载点出现：若该终端还没 xterm 实例，创建并 open
    mountEls.set(id, el)
    if (!instances.has(id)) {
      initTerminal(id, el)
    }
  } else {
    // div 被卸载（终端被 kill 后 v-for 移除）
    mountEls.delete(id)
  }
}

/** 为指定终端 id 创建 xterm 实例并 open 到挂载点。 */
function initTerminal(id: string, el: HTMLElement): void {
  const term = new Terminal({
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
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon())
  term.open(el)
  try {
    fit.fit()
    void terminalStore.resize(id, term.cols, term.rows)
  } catch {
    // 容器还没布局好
  }

  // 用户输入 → pty
  term.onData((data) => {
    void terminalStore.write(id, data)
  })

  instances.set(id, { term, fit })
}

/** dispose 指定终端的 xterm 实例。 */
function disposeTerminal(id: string): void {
  const inst = instances.get(id)
  if (inst) {
    inst.term.dispose()
    instances.delete(id)
  }
}

/** 让激活终端自适应尺寸 + 同步给 pty。 */
function fitActive(): void {
  const id = terminalStore.activeId
  if (!id) return
  const inst = instances.get(id)
  if (!inst) return
  try {
    inst.fit.fit()
    void terminalStore.resize(id, inst.term.cols, inst.term.rows)
  } catch {
    // ignore
  }
}

// —— pty 数据路由：组件级单次订阅，按 id 分发到对应 xterm ——
let unsubData: (() => void) | null = null
let unsubExit: (() => void) | null = null

onMounted(() => {
  unsubData = window.api.pty.onData(({ id, data }) => {
    // 每个终端的输出写入它自己的 xterm（不论是否当前激活），后台输出不丢
    instances.get(id)?.term.write(data)
  })
  unsubExit = window.api.pty.onExit(({ id, exitCode }) => {
    instances.get(id)?.term.write(`\r\n[process exited with code ${exitCode}]\r\n`)
    terminalStore.removeLocal(id)
  })
})

onUnmounted(() => {
  unsubData?.()
  unsubExit?.()
  for (const id of [...instances.keys()]) disposeTerminal(id)
})

// —— 容器 resize → 激活终端 fit（rAF 节流，拖拽时避免高频重绘卡顿）——
let fitRafId: number | null = null
function scheduleFit(): void {
  if (fitRafId !== null) return
  fitRafId = requestAnimationFrame(() => {
    fitRafId = null
    fitActive()
  })
}

let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  const container = rootRef.value
  if (!container) return
  resizeObserver = new ResizeObserver(() => scheduleFit())
  resizeObserver.observe(container)
})
onUnmounted(() => {
  if (fitRafId !== null) cancelAnimationFrame(fitRafId)
  resizeObserver?.disconnect()
  resizeObserver = null
})

// 切换 tab 时让新激活的终端 fit（从隐藏切到显示，尺寸可能变化）
watch(
  () => terminalStore.activeId,
  () => nextTick(() => fitActive()),
)

// 终端被 kill（从 store terminals 数组移除）后，清理对应 xterm 实例
watch(
  () => terminalStore.terminals.map((t) => t.id),
  (currentIds, prevIds) => {
    const removed = (prevIds ?? []).filter((id) => !currentIds.includes(id))
    for (const id of removed) disposeTerminal(id)
  },
)

// —— 重命名交互 ——
const renamingId = ref<string | null>(null)
const renameValue = ref('')
let renameInputEl: HTMLInputElement | null = null

function setRenameInput(el: HTMLInputElement | null): void {
  renameInputEl = el
}

function startRename(id: string, currentName: string): void {
  renamingId.value = id
  renameValue.value = currentName
  void nextTick(() => {
    renameInputEl?.focus()
    renameInputEl?.select()
  })
}

function commitRename(id: string): void {
  if (renamingId.value === id) {
    terminalStore.rename(id, renameValue.value)
    renamingId.value = null
  }
}

function cancelRename(): void {
  renamingId.value = null
}

async function createTerminal(): Promise<void> {
  // 无 workspace 时传空串，由 main 侧 PtyManager 用 process.cwd() 兜底
  const cwd = workspaceStore.currentWorkspace?.path ?? ''
  // tab 名用当前工作区名（同名递增由 store 处理）
  const workspaceName = workspaceStore.currentWorkspace?.name
  await terminalStore.create(cwd, workspaceName)
}

// 首次进入时如果没终端，自动创建一个
onMounted(() => {
  if (terminalStore.terminals.length === 0) {
    void createTerminal()
  }
})
</script>
