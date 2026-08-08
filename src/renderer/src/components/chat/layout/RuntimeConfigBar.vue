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

    <!-- 窗口置顶开关：与设置页/欢迎页共用 useAlwaysOnTop 单例，跨页面状态同步。 -->
    <AlwaysOnTopButton />

    <!--
      Open With: 全局「打开方式」入口（图标 + 箭头两块）。
      - 点图标：用选中应用（IDE / Finder）打开当前工作区目录
      - 点箭头：展开下拉选 IDE
      应用列表 = Finder（默认）+ 白名单内的编程 IDE。仅 macOS。
    -->
    <DropdownMenu
      v-if="openWithPlatform === 'darwin'"
      :model-value="selectedApp?.path ?? null"
      :options="openWithOptions"
      split-action
      :title="`选择打开方式${selectedApp ? '：' + selectedApp.name : ''}`"
      :action-title="`用「${selectedApp?.name ?? 'Finder'}」打开工作区`"
      @update:model-value="onSelectOpenWithApp"
      @action="openWorkspaceWithSelected"
    />

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
import AlwaysOnTopButton from '@renderer/components/AlwaysOnTopButton.vue'
import TitleBarControls from '@renderer/components/TitleBarControls.vue'
import { DropdownMenu, type DropdownOption } from '@renderer/components/ui/dropdown-menu'
import { useOpenWith } from '@renderer/composables/useOpenWith'
import { useMessageStore } from '@renderer/stores/message'
import { useSessionStore } from '@renderer/stores/session'
import { useUiStore } from '@renderer/stores/ui'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type { OpenWithApp } from '@shared/ipc/system'
import {
  ListTodoIcon,
  LoaderCircleIcon,
  PanelBottomIcon,
  PanelLeftIcon,
  PanelRightIcon,
} from 'lucide-vue-next'
import { computed, onMounted, ref } from 'vue'

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
const workspaceStore = useWorkspaceStore()
const {
  platform: openWithPlatform,
  selectedApp,
  initOpenWith,
  listInstalledApps,
  openWith,
  selectApp,
} = useOpenWith()

// Open With 下拉的应用列表：扫 /Applications 取所有已装应用（不依赖具体文件）。
// 这样 dropdown 始终可用——用户可以在加引用前就选好打开方式。
const openWithAppList = ref<OpenWithApp[]>([])

const openWithOptions = computed<DropdownOption<string | null>[]>(() =>
  openWithAppList.value.map((app) => ({
    value: app.path,
    label: app.name,
    ...(app.icon && { icon: app.icon }),
  })),
)

function onSelectOpenWithApp(value: string | null): void {
  const app = openWithAppList.value.find((a) => a.path === value)
  if (app) void selectApp(app)
}

/**
 * 点图标：用当前选中的应用打开当前工作区目录。
 * open -a <app> <dir> 对 Finder（定位该目录）和 IDE（打开为项目）都成立。
 * 没选过应用时 selectedApp 为 null，openWith 内部回落到系统默认（openPath）。
 */
function openWorkspaceWithSelected(): void {
  const dir = workspaceStore.currentWorkspace?.path
  if (!dir) return
  void openWith(dir, selectedApp.value)
}

// 挂载时先拉保存的偏好（initOpenWith），再拉应用列表。
// 顺序很重要：必须先确认 selectedApp 是不是真的为 null（用户没选过），
// 再决定是否落到默认 Finder——否则会在偏好还没加载时误选 Finder。
onMounted(async () => {
  await initOpenWith()
  if (openWithPlatform.value !== 'darwin') return
  openWithAppList.value = await listInstalledApps()
  // 默认 = Finder（列表第一项）。用户没保存过偏好时落到 Finder 并持久化。
  if (!selectedApp.value && openWithAppList.value[0]) {
    await selectApp(openWithAppList.value[0])
  }
})
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
