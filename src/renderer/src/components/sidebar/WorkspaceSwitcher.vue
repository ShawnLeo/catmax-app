<template>
  <div class="p-2 border-b border-sidebar-border relative">
    <button
      class="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted text-left"
      @click="showPicker = !showPicker"
    >
      <FolderIcon class="w-4 h-4 flex-shrink-0 text-muted-foreground" />
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium text-foreground truncate">
          {{ workspaceStore.currentWorkspace?.name ?? '选择工作区' }}
        </div>
        <div
          v-if="workspaceStore.currentWorkspace"
          class="text-xs text-muted-foreground truncate font-mono"
        >
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
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { FolderIcon, ChevronDownIcon, PlusIcon } from 'lucide-vue-next'
import { ref, onMounted } from 'vue'

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
    const { useMessageStore } = await import('@renderer/stores/message')
    const sessionStore = useSessionStore()
    const messageStore = useMessageStore()
    // 切工作区彻底清空——不同工作区的 session 状态不混用
    messageStore.resetAll()
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
