<template>
  <div class="relative h-full flex flex-col">
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
    <div ref="container" class="flex-1 overflow-hidden" />

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
import { useTerminal } from '@renderer/composables/useTerminal'
import { useTerminalStore } from '@renderer/stores/terminal'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { PlusIcon, TerminalIcon } from 'lucide-vue-next'
import { computed, onMounted, ref } from 'vue'

const terminalStore = useTerminalStore()
const workspaceStore = useWorkspaceStore()
const container = ref<HTMLElement | null>(null)

const activeTerminalId = computed(() => terminalStore.activeId)

useTerminal(container, activeTerminalId)

async function createTerminal(): Promise<void> {
  // 无 workspace 时传空串，由 main 侧 PtyManager 用 process.cwd() 兜底
  const cwd = workspaceStore.currentWorkspace?.path ?? ''
  await terminalStore.create(cwd)
}

// 首次进入时如果没终端，自动创建一个
onMounted(() => {
  if (terminalStore.terminals.length === 0) {
    void createTerminal()
  }
})
</script>
