<template>
  <div class="h-full">
    <RouterView />

    <CommandPalette v-model:visible="commandPaletteVisible" />
    <!-- Image Preview Overlay: 整应用一份，由 image-preview store 驱动显隐 -->
    <ImagePreviewOverlay />
  </div>
</template>

<script setup lang="ts">
import ImagePreviewOverlay from '@renderer/components/chat/overlays/ImagePreviewOverlay.vue'
import CommandPalette from '@renderer/components/command/CommandPalette.vue'
import { useTheme } from '@renderer/composables/useTheme'
import { useAuthStore } from '@renderer/stores/auth'
import { useBackendStore } from '@renderer/stores/backend'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiStore } from '@renderer/stores/ui'
import { computed } from 'vue'
import { onMounted } from 'vue'
import { watch } from 'vue'
import { useRouter } from 'vue-router'

const uiStore = useUiStore()
const backendStore = useBackendStore()
const authStore = useAuthStore()
const router = useRouter()

// 切换后端时清空审查快照——审查内容是旧后端某轮改动的只读快照，跨后端已无意义。
watch(
  () => backendStore.currentId,
  () => {
    uiStore.clearReview()
  },
)

// 内测登录态：退出登录时路由守卫的 beforeEach 只在「下次导航」才触发，
// 当前页不会自动离开。这里兜底——登录态变 false 立即跳 /login，
// 覆盖任意 logout 入口（侧栏菜单 / 欢迎页按钮）。
watch(
  () => authStore.loggedIn,
  (loggedIn) => {
    if (!loggedIn) router.push('/login')
  },
)

// 双向绑定到 uiStore.commandPaletteVisible（让命令系统的 mod+k 能控制 palette）
const commandPaletteVisible = computed({
  get: () => uiStore.commandPaletteVisible,
  set: (v: boolean) => {
    if (v) uiStore.openCommandPalette()
    else uiStore.closeCommandPalette()
  },
})

const settings = useSettingsStore()
const { apply } = useTheme()

onMounted(async () => {
  await settings.load()
  if (settings.settings) {
    apply(settings.settings.theme.mode)
    uiStore.loadWidths(
      settings.settings.sidebarWidth,
      settings.settings.rightPanelWidth,
      settings.settings.bottomPanelHeight,
    )
  }
})
</script>
