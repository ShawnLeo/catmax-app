<template>
  <!--
    侧栏顶部：窗口控制按钮 + 工作区切换（简化样式）。
    整条作为窗口拖拽区，交互元素（按钮）单独标记 no-drag。
  -->
  <div
    class="h-12 flex items-center gap-2 px-3 border-b border-sidebar-border relative window-drag-region"
  >
    <!-- 窗口控制按钮（macOS 红绿灯 / Windows 标准按钮） -->
    <TitleBarControls />

    <!-- 工作区切换触发器：Catmax logo + 名字 + 下拉箭头 -->
    <button
      ref="triggerRef"
      class="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted text-left interactive cursor-pointer"
      @click="showPicker = !showPicker"
    >
      <CatmaxLogo variant="plain" class="w-5 h-5 flex-shrink-0 text-foreground" />
      <span class="flex-1 min-w-0 text-sm font-medium text-foreground truncate">
        {{ workspaceStore.currentWorkspace?.name ?? '选择工作区' }}
      </span>
      <ChevronDownIcon class="w-4 h-4 flex-shrink-0 text-muted-foreground" />
    </button>

    <!--
      工作区列表——Teleport 到 body，避免被侧栏祖先容器（overflow / 层叠上下文）裁掉。
      定位用 triggerRef 的 getBoundingClientRect() 计算，跟随触发按钮。
    -->
    <Teleport to="body">
      <div
        v-if="showPicker && dropdownStyle"
        ref="dropdownRef"
        class="fixed z-[9999] w-56 rounded-lg border border-border bg-accent shadow-xl overflow-hidden"
        :style="dropdownStyle"
        @click.stop
      >
        <div class="max-h-96 overflow-y-auto">
          <button
            v-for="ws in workspaceStore.workspaces"
            :key="ws.id"
            class="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted text-left cursor-pointer"
            @click="selectWorkspace(ws.id)"
          >
            <FolderIcon class="w-4 h-4 flex-shrink-0 text-muted-foreground" />
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium truncate">{{ ws.name }}</div>
              <div class="text-xs text-muted-foreground truncate font-mono">{{ ws.path }}</div>
            </div>
          </button>
        </div>
        <button
          class="w-full flex items-center gap-2 px-3 py-2 border-t border-border hover:bg-muted text-left text-sm cursor-pointer"
          @click="addWorkspace"
        >
          <PlusIcon class="w-4 h-4" />
          <span>添加工作区</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import CatmaxLogo from '@renderer/components/icons/CatmaxLogo.vue'
import TitleBarControls from '@renderer/components/TitleBarControls.vue'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { FolderIcon, ChevronDownIcon, PlusIcon } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

const workspaceStore = useWorkspaceStore()
const showPicker = ref(false)
const dropdownRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLElement | null>(null)

// 下拉框定位——基于触发按钮的视口坐标。Teleport 到 body 后不能用 absolute，
// 用 fixed + 实时算 top/left，保证不被任何 overflow 祖先裁掉。
const dropdownTop = ref(0)
const dropdownLeft = ref(0)
const dropdownStyle = computed(() => ({
  top: `${dropdownTop.value}px`,
  left: `${dropdownLeft.value}px`,
}))

function updateDropdownPosition(): void {
  const rect = triggerRef.value?.getBoundingClientRect()
  if (!rect) return
  dropdownTop.value = rect.bottom + 4
  dropdownLeft.value = rect.left
}

// 打开下拉时算一次位置（等 DOM 渲染完），并监听窗口变化跟随定位
function handleResize(): void {
  if (showPicker.value) updateDropdownPosition()
}

watch(showPicker, async (open) => {
  if (open) {
    await nextTick()
    updateDropdownPosition()
    window.addEventListener('resize', handleResize)
  } else {
    window.removeEventListener('resize', handleResize)
  }
})

onMounted(async () => {
  await workspaceStore.load()
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
  window.removeEventListener('resize', handleResize)
})

function handleClickOutside(event: MouseEvent): void {
  const target = event.target as Node
  const isInsideDropdown = dropdownRef.value?.contains(target)
  const isInsideTrigger = triggerRef.value?.contains(target)

  if (!isInsideDropdown && !isInsideTrigger) {
    showPicker.value = false
  }
}

async function selectWorkspace(id: string): Promise<void> {
  await workspaceStore.setCurrent(id)
  showPicker.value = false
  // 重新加载该工作区的 sessions（按当前 backend 过滤）
  if (workspaceStore.currentWorkspace) {
    const { useSessionStore } = await import('@renderer/stores/session')
    const { useMessageStore } = await import('@renderer/stores/message')
    const { useBackendStore } = await import('@renderer/stores/backend')
    const sessionStore = useSessionStore()
    const messageStore = useMessageStore()
    const backendStore = useBackendStore()
    // 切工作区彻底清空——不同工作区的 session 状态不混用
    messageStore.resetAll()
    await sessionStore.load(workspaceStore.currentWorkspace.id, backendStore.currentId)
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

<style scoped>
/* 整条作为窗口拖拽区，交互元素标记 .interactive 关掉拖拽 */
.window-drag-region {
  -webkit-app-region: drag;
}

.interactive {
  -webkit-app-region: no-drag;
}
</style>
