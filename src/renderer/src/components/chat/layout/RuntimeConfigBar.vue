<template>
  <!-- 顶部配置条：侧栏切换 + 会话标题 + backend 状态 + 右栏切换。
       窗口控制按钮和当前工作区名已移到侧栏顶部（WorkspaceSwitcher）。 -->
  <div
    :class="[
      'border-b border-border px-4 h-12 flex items-center gap-2 bg-background',
      // Window Drag Region: 有浮层盖住这一条时必须整条退出拖拽区，见 windowDraggable。
      windowDraggable ? 'window-drag-region' : '',
    ]"
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

    <!-- 窗口置顶开关：常驻右侧工具组、底部面板按钮之前。 -->
    <button
      class="p-1.5 rounded-md transition-colors"
      :class="isAlwaysOnTop ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'"
      :title="isAlwaysOnTop ? '取消置顶' : '置顶窗口'"
      :aria-label="isAlwaysOnTop ? '取消置顶' : '置顶窗口'"
      :aria-pressed="isAlwaysOnTop"
      @click="toggleAlwaysOnTop"
    >
      <PinIcon class="w-4 h-4" :fill="isAlwaysOnTop ? 'currentColor' : 'none'" />
    </button>

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
  PinIcon,
} from 'lucide-vue-next'
import { onMounted, ref } from 'vue'

interface Props {
  /**
   * Window Drag Region: 这一条是否声明为窗口拖拽区。
   *
   * Electron 的拖拽区不走 DOM 命中测试——渲染层把所有 `-webkit-app-region` 矩形交给
   * 主进程，主进程把它们合并成一个 SkRegion（drag 并集、no-drag 差集），命中只看点
   * 落没落在这个集合里，跟 z-index、跟谁盖着谁完全无关。
   *
   * 窄窗口下侧栏/右栏切成浮层后会盖住这一条（两者都是顶部 48px，完全重叠），于是同一
   * 片像素上有两个组件各自声明 drag 和 no-drag。合并结果由矩形顺序决定，浮层内部按钮
   * 挖出的 no-drag 洞会被这一条整宽的 drag 填回去——按钮点上去只是在拖窗口，事件根本
   * 到不了渲染层（表现为工作区下拉打不开、右栏 tab 点不动）。
   *
   * 解法是让重叠区域只有一个声明者：浮层展开时这一条整条退出（既不 union 也不
   * difference），浮层自己的标题栏继续负责拖拽。
   */
  windowDraggable?: boolean
}

withDefaults(defineProps<Props>(), { windowDraggable: true })

const sessionStore = useSessionStore()
const uiStore = useUiStore()
const messageStore = useMessageStore()
const isAlwaysOnTop = ref(false)

onMounted(async () => {
  isAlwaysOnTop.value = await window.api.system.windowIsAlwaysOnTop()
})

async function toggleAlwaysOnTop(): Promise<void> {
  isAlwaysOnTop.value = await window.api.system.windowToggleAlwaysOnTop()
}
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
