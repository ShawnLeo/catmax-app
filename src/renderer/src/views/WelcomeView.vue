<template>
  <div class="h-full flex flex-col">
    <!-- 顶部标题栏：窗口控制按钮 + 可拖拽区域 + 设置入口。
         无侧栏页面，窗口按钮直接放顶条最左侧，跟 ChatView 高度一致（h-12）。 -->
    <div
      class="h-12 shrink-0 flex items-center gap-2 px-3 border-b border-border bg-background titlebar"
    >
      <TitleBarControls />
      <div class="flex-1" />
      <Button variant="ghost" size="sm" class="interactive" @click="router.push('/settings')">
        设置
      </Button>
    </div>

    <!-- 主体：居中内容 -->
    <div class="flex-1 flex flex-col items-center justify-center gap-6 p-8">
      <div class="flex flex-col items-center gap-4">
        <CatmaxLogo variant="badge" class="w-20 h-20 rounded-[22%] shadow-lg" />
        <div class="text-center">
          <h1 class="text-3xl font-bold text-foreground">Catmax</h1>
          <p class="mt-2 text-muted-foreground">选择一个本地文件夹作为工作区</p>
        </div>
      </div>

      <Button size="lg" :disabled="adding" @click="addWorkspace">
        {{ adding ? '添加中...' : '选择工作区' }}
      </Button>

      <div v-if="workspaceStore.workspaces.length > 0" class="w-full max-w-md">
        <h2 class="text-sm font-medium text-muted-foreground mb-2">最近工作区</h2>
        <!-- 高度按窗口比例限制，超出滚动；列表后端已按 last_opened_at DESC 排序，
             这里只取最近 20 个。 -->
        <div class="flex flex-col gap-1 max-h-[40vh] overflow-y-auto pr-1">
          <button
            v-for="ws in recentWorkspaces"
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
  </div>
</template>

<script setup lang="ts">
import CatmaxLogo from '@renderer/components/icons/CatmaxLogo.vue'
import TitleBarControls from '@renderer/components/TitleBarControls.vue'
import { Button } from '@renderer/components/ui/button'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const workspaceStore = useWorkspaceStore()
const adding = ref(false)

// 后端 list 已按 last_opened_at DESC 排序，取前 20 即最近的工作区。
const recentWorkspaces = computed(() => workspaceStore.workspaces.slice(0, 20))

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
      // add() 内部已 setCurrent(ws.id)，这里只需导航
      await workspaceStore.add(result.filePaths[0]!)
      router.push('/chat')
    }
  } finally {
    adding.value = false
  }
}

async function openWorkspace(id: string): Promise<void> {
  await workspaceStore.setCurrent(id)
  router.push('/chat')
}
</script>

<style scoped>
.titlebar {
  -webkit-app-region: drag;
}

.interactive {
  -webkit-app-region: no-drag;
}
</style>
