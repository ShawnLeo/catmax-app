<template>
  <div class="h-full flex flex-col items-center justify-center gap-6 p-8 relative">
    <Button
      variant="ghost"
      size="sm"
      class="absolute top-4 right-4"
      @click="router.push('/settings')"
    >
      设置
    </Button>

    <div class="text-center">
      <h1 class="text-3xl font-bold text-foreground">catmax</h1>
      <p class="mt-2 text-muted-foreground">选择一个本地文件夹作为工作区</p>
    </div>

    <Button size="lg" :disabled="adding" @click="addWorkspace">
      {{ adding ? '添加中...' : '选择工作区' }}
    </Button>

    <div v-if="workspaceStore.workspaces.length > 0" class="w-full max-w-md">
      <h2 class="text-sm font-medium text-muted-foreground mb-2">最近工作区</h2>
      <div class="flex flex-col gap-1">
        <button
          v-for="ws in workspaceStore.workspaces"
          :key="ws.id"
          class="text-left p-3 rounded-md hover:bg-muted transition-colors"
          @click="openWorkspace(ws.id)"
        >
          <div class="font-medium text-foreground">{{ ws.name }}</div>
          <div class="text-xs text-muted-foreground font-mono truncate">{{ ws.path }}</div>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Button } from '@renderer/components/ui/button'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const workspaceStore = useWorkspaceStore()
const adding = ref(false)

onMounted(async () => {
  await workspaceStore.load()
})

async function addWorkspace(): Promise<void> {
  adding.value = true
  try {
    const result = await window.api.system.openDialog({
      title: '选择工作区文件夹',
      properties: ['openDirectory'],
    })
    if (!result.canceled && result.filePaths.length > 0) {
      const ws = await workspaceStore.add(result.filePaths[0]!)
      openWorkspace(ws.id)
    }
  } finally {
    adding.value = false
  }
}

function openWorkspace(id: string): void {
  workspaceStore.setCurrent(id)
  router.push('/chat')
}
</script>
