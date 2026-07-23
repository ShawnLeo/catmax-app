<template>
  <!-- 顶部配置条：侧栏切换 + 会话标题 + backend 状态 + 右栏切换。
       窗口控制按钮和当前工作区名已移到侧栏顶部（WorkspaceSwitcher）。 -->
  <div
    class="border-b border-border px-4 h-12 flex items-center gap-2 bg-background window-drag-region"
  >
    <!-- 窗口控制按钮：仅在侧栏折叠时出现（侧栏展开时由 WorkspaceSwitcher 顶条显示） -->
    <TitleBarControls v-if="uiStore.sidebarCollapsed" />

    <!-- 左侧切换按钮 -->
    <button
      class="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
      title="切换侧栏"
      @click="uiStore.toggleSidebar()"
    >
      <PanelLeftIcon class="w-4 h-4" />
    </button>

    <!-- 会话标题 -->
    <h1 class="text-sm font-medium text-foreground truncate">
      {{ sessionStore.currentSession?.title ?? '新会话' }}
    </h1>

    <div class="flex-1" />

<!-- 底部终端面板切换按钮（在右栏切换按钮前） -->
    <button
      :class="[
        'p-1.5 rounded-md hover:bg-muted transition-colors',
        uiStore.bottomPanelVisible
          ? 'text-foreground'
          : 'text-muted-foreground hover:text-foreground',
      ]"
      title="切换终端"
      @click="uiStore.toggleBottomPanel()"
    >
      <PanelBottomIcon class="w-4 h-4" />
    </button>

    <!-- 右侧切换按钮 -->
    <button
      :class="[
        'p-1.5 rounded-md hover:bg-muted transition-colors',
        uiStore.rightPanelVisible
          ? 'text-foreground'
          : 'text-muted-foreground hover:text-foreground',
      ]"
      title="切换右栏"
      @click="uiStore.toggleRightPanel()"
    >
      <PanelRightIcon class="w-4 h-4" />
    </button>
  </div>
</template>

<script setup lang="ts">
import TitleBarControls from '@renderer/components/TitleBarControls.vue'
import { useSessionStore } from '@renderer/stores/session'
import { useUiStore } from '@renderer/stores/ui'
import { PanelBottomIcon, PanelLeftIcon, PanelRightIcon } from 'lucide-vue-next'

const sessionStore = useSessionStore()
const uiStore = useUiStore()
</script>

<style scoped>
.window-drag-region {
  -webkit-app-region: drag;
}

/* 所有直接子元素默认不可拖拽，保证按钮等可交互 */
.window-drag-region > * {
  -webkit-app-region: no-drag;
}

/* 但是标题文字区域可以拖拽 */
.window-drag-region > h1 {
  -webkit-app-region: drag;
}
</style>
