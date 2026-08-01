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
    <h1 class="text-[length:var(--chat-text-u1)] font-medium text-foreground truncate">
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

    <!--
      Background Tasks Indicator: 后台任务的常驻入口。
      只在有任务时出现——它的全部意义是回答"我刚让它去后台干的事怎么样了"，
      而那件事发生时用户通常已经滚到别处，消息流里的卡片指望不上。
    -->
    <button
      v-if="messageStore.backgroundTasks.length > 0"
      class="p-1.5 rounded-md hover:bg-muted transition-colors inline-flex items-center gap-1"
      :class="
        messageStore.runningBackgroundTaskCount > 0
          ? 'text-primary'
          : 'text-muted-foreground hover:text-foreground'
      "
      :title="
        messageStore.runningBackgroundTaskCount > 0
          ? `${messageStore.runningBackgroundTaskCount} 个后台任务运行中`
          : '查看后台任务'
      "
      @click="uiStore.showRightPanel('tasks')"
    >
      <LoaderCircleIcon
        v-if="messageStore.runningBackgroundTaskCount > 0"
        class="w-4 h-4 animate-spin"
      />
      <ListTodoIcon v-else class="w-4 h-4" />
      <span
        v-if="messageStore.runningBackgroundTaskCount > 0"
        class="text-[length:var(--chat-text-d2)] font-medium"
      >
        {{ messageStore.runningBackgroundTaskCount }}
      </span>
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
import { useMessageStore } from '@renderer/stores/message'
import { useSessionStore } from '@renderer/stores/session'
import { useUiStore } from '@renderer/stores/ui'
import {
  ListTodoIcon,
  LoaderCircleIcon,
  PanelBottomIcon,
  PanelLeftIcon,
  PanelRightIcon,
} from 'lucide-vue-next'

const sessionStore = useSessionStore()
const uiStore = useUiStore()
const messageStore = useMessageStore()
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
