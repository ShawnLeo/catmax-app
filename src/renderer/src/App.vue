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
import { useUpdateStore } from '@renderer/stores/update'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { computed } from 'vue'
import { onMounted } from 'vue'
import { watch } from 'vue'
import { useRouter } from 'vue-router'

const uiStore = useUiStore()
const backendStore = useBackendStore()
const authStore = useAuthStore()
const workspaceStore = useWorkspaceStore()
const updateStore = useUpdateStore()
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

// Tray Gating: 把「当前页面能不能新建会话」上报给主进程，托盘右键菜单用它决定
// 「新建会话」是否置灰。三个条件缺一不可——未登录时路由守卫会把导航拦回 /login；
// 停在欢迎页 / 设置页时命令没有可落地的聊天界面；没有选中工作区时连 cwd 都没有。
// 登录态主进程自己也有（auth.json 是权威源），这里带上只是为了状态一变立刻同步，
// 不必等下一次路由跳转。immediate 保证窗口重建后新渲染层挂载即上报，
// 覆盖掉主进程侧可能残留的上一个窗口的值。
watch(
  () => ({
    canCreateSession:
      authStore.loggedIn &&
      router.currentRoute.value.name === 'chat' &&
      !!workspaceStore.currentWorkspace,
  }),
  (context) => {
    void window.api.system.setTrayContext(context)
  },
  { immediate: true, deep: true },
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

  // Hot Update: 订阅状态推送。不 await——它只驱动一张提示卡片，
  // 拿它挡住首屏没有任何意义。
  void updateStore.init()
})
</script>
