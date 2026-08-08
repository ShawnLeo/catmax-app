<template>
  <!--
    两种形态共用同一棵结构：
    - docked（默认）：参与布局，跟主聊天区并排；始终挂载，隐藏时宽度收为 0 走 transition。
    - overlay：Right Panel Overlay 的浮层形态，显隐由父级 v-if + Transition 控制，
      宽度恒为 panelWidth（不再收 0），定位交给外层容器。
  -->
  <aside
    :class="[
      'flex flex-col bg-card overflow-hidden',
      isOverlay
        ? 'h-full shadow-lg'
        : ['shrink-0', uiStore.panelDragging ? '' : 'transition-[width] duration-200 ease-out'],
    ]"
    :style="{ width: outerWidth + 'px' }"
    :aria-hidden="isOverlay ? undefined : !uiStore.rightPanelVisible"
  >
    <div class="h-full flex flex-col" :style="{ width: panelWidth + 'px' }">
      <!-- Tab 头 -->
      <div
        class="right-panel-titlebar h-12 flex items-end border-b border-border"
        @dblclick="onTitlebarDoubleClick"
      >
        <!--
          pt-[2px] 抵消 border-b-2：下边框吃掉内容盒 2px，items-center 居中后文字会比
          按钮的几何中心高 1px——加回 2px 上内边距，内容盒重新对称。
        -->
        <button
          v-for="tab in tabs"
          :key="tab.id"
          :class="[
            'h-12 w-24 pt-[2px] flex items-center justify-center gap-1.5 text-[length:var(--ui-text-d2)] font-medium border-b-2 transition-colors',
            uiStore.rightPanelTab === tab.id
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40',
          ]"
          @click="uiStore.setRightPanelTab(tab.id)"
        >
          <component :is="tab.icon" class="w-3.5 h-3.5" />
          {{ tab.label }}
          <span
            v-if="tab.badge"
            class="min-w-4 h-4 px-1 rounded-full bg-muted text-[length:var(--ui-text-d5)] grid place-items-center"
          >
            {{ tab.badge }}
          </span>
        </button>
        <div class="flex-1" />
        <button
          type="button"
          class="w-9 h-12 grid place-items-center text-muted-foreground hover:text-foreground hover:bg-muted/40"
          title="关闭右侧面板"
          @click="uiStore.hideRightPanel"
        >
          <XIcon class="w-3.5 h-3.5" />
        </button>
      </div>

      <!-- Tab 内容 -->
      <div class="flex-1 overflow-hidden">
        <GitPanel v-if="uiStore.rightPanelTab === 'git'" />
        <ReviewPanel v-else-if="uiStore.rightPanelTab === 'review'" />
        <TasksPanel v-else-if="uiStore.rightPanelTab === 'tasks'" />
        <div v-else class="h-full min-w-0 flex">
          <!--
            File Preview Split: 空间够时预览区固定在文件树左侧；不够时（splitActive=false）
            退成单栏——只渲染其中一个并铺满整条面板，两者靠各自标题栏上的按钮互相切换。
          -->
          <FilePreview
            v-if="previewPaneVisible"
            :class="splitActive ? 'shrink-0' : 'flex-1 min-w-0'"
            :style="splitActive ? { width: uiStore.filePreviewWidth + 'px' } : undefined"
            :show-file-tree-button="!uiStore.fileTreeVisible"
            @show-file-tree="uiStore.setFileTreeVisible(true)"
          />
          <ResizeHandle
            v-if="splitActive"
            side="left"
            :min="FILE_PREVIEW_MIN"
            :max="filePreviewMax"
            :current="uiStore.filePreviewWidth"
            @resize="resizeFilePreview"
            @reach-max="uiStore.setFileTreeVisible(false)"
          />
          <FileTree
            v-if="treePaneVisible"
            :class="splitActive ? 'shrink-0' : 'flex-1 min-w-0'"
            :style="splitActive ? { width: uiStore.rightPanelWidth + 'px' } : undefined"
            :show-preview-button="!splitActive && previewAvailable"
            @show-preview="uiStore.setFileTreeVisible(false)"
          />
        </div>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import {
  FILE_PREVIEW_MIN,
  FILE_SPLIT_HANDLE_WIDTH,
  FILE_TREE_MIN,
} from '@renderer/lib/panel-layout'
import { useFilesStore } from '@renderer/stores/files'
import { useGitStore } from '@renderer/stores/git'
import { useMessageStore } from '@renderer/stores/message'
import { type RightPanelTab, useUiStore } from '@renderer/stores/ui'
import { FilesIcon, GitBranchIcon, GitCompareIcon, ListTodoIcon, XIcon } from 'lucide-vue-next'
import { computed, watch, type Component } from 'vue'

import ResizeHandle from '../ui/ResizeHandle.vue'

import FilePreview from './FilePreview.vue'
import FileTree from './FileTree.vue'
import GitPanel from './GitPanel.vue'
import ReviewPanel from './ReviewPanel.vue'
import TasksPanel from './TasksPanel.vue'

interface Props {
  /** docked = 参与布局的常驻右栏；overlay = 窄窗口下浮在聊天区之上的形态 */
  variant?: 'docked' | 'overlay'
  /**
   * File Preview Split: 当前窗口放得下"预览 + 文件树"并排吗？由 ChatView 按可用宽度
   * 判定（见 MIN_WIDTH_FOR_FILE_SPLIT）。为 false 时退成单栏，同一时刻只显示一个。
   */
  fileSplitAllowed?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'docked',
  fileSplitAllowed: true,
})

const isOverlay = computed(() => props.variant === 'overlay')

const uiStore = useUiStore()
const gitStore = useGitStore()
const filesStore = useFilesStore()
const messageStore = useMessageStore()
// File Preview Split: 外层面板宽度等于预览区与文件树宽度之和。
// Review tab 自带左右 split（文件树 + diff），不叠加 filePreviewWidth，宽度即 rightPanelWidth。
const previewAvailable = computed(() => filesStore.previewTabs.length > 0)
const previewVisible = computed(() => uiStore.rightPanelTab === 'files' && previewAvailable.value)

/** 预览和文件树真的并排显示（空间够 + 用户没手动收起文件树）。 */
const splitActive = computed(
  () => previewVisible.value && uiStore.fileTreeVisible && props.fileSplitAllowed,
)
// 单栏形态下 fileTreeVisible 的含义从"是否并排显示文件树"变成"这一栏是树还是预览"。
const previewPaneVisible = computed(
  () => previewVisible.value && (splitActive.value || !uiStore.fileTreeVisible),
)
const treePaneVisible = computed(
  () => uiStore.rightPanelTab === 'files' && (!previewAvailable.value || uiStore.fileTreeVisible),
)

const panelWidth = computed(() => {
  if (uiStore.rightPanelTab !== 'files') return uiStore.rightPanelWidth
  if (splitActive.value) {
    return uiStore.filePreviewWidth + uiStore.rightPanelWidth + FILE_SPLIT_HANDLE_WIDTH
  }
  // 单栏：整条面板就是那一栏，宽度取它自己的。
  return previewPaneVisible.value ? uiStore.filePreviewWidth : uiStore.rightPanelWidth
})
const filePreviewMax = computed(
  () => uiStore.filePreviewWidth + uiStore.rightPanelWidth - FILE_TREE_MIN,
)

// 浮层由父级挂载/卸载，不走"宽度收 0"那套隐藏动画。
const outerWidth = computed(() => {
  if (isOverlay.value) return panelWidth.value
  return uiStore.rightPanelVisible ? panelWidth.value : 0
})

interface PanelTab {
  id: RightPanelTab
  label: string
  icon: Component
  badge: number | undefined
}

function resizeFilePreview(width: number): void {
  // File Preview Split: 分隔条只重新分配现有空间，不改变组合右栏的总宽度。
  if (!uiStore.fileTreeVisible) {
    uiStore.setFilePreviewWidth(width)
    return
  }
  const combinedWidth = uiStore.filePreviewWidth + uiStore.rightPanelWidth
  uiStore.setFilePreviewWidth(width)
  uiStore.setRightPanelWidth(combinedWidth - width)
}

// File Preview Split: 单栏形态下从文件树里打开一个文件，得自己让位给预览——否则用户
// 点了文件却停在原来的树上，像是没反应。并排时两边同时可见，不需要切换。
watch(
  () => filesStore.activePreviewPath,
  (path) => {
    if (!path || props.fileSplitAllowed) return
    if (uiStore.rightPanelTab !== 'files') return
    uiStore.setFileTreeVisible(false)
  },
)

async function onTitlebarDoubleClick(event: MouseEvent): Promise<void> {
  // Electron Titlebar: 交互控件不参与窗口放大；仅标题栏空白区域响应双击。
  if ((event.target as HTMLElement).closest('button')) return
  await window.api.system.windowMaximize()
}

const tabs = computed(() => {
  const items: PanelTab[] = [
    {
      id: 'files' as const,
      label: '文件',
      icon: FilesIcon,
      badge: undefined,
    },
  ]

  // Background Tasks Tab: 仅在该会话出现过后台任务后显示——没跑过后台任务的
  // 会话摆一个永远空的 tab 只是噪音。徽标只数运行中的，已完成的不该一直占着注意力。
  if (messageStore.backgroundTasks.length > 0) {
    items.push({
      id: 'tasks' as const,
      label: '后台',
      icon: ListTodoIcon,
      badge:
        messageStore.runningBackgroundTaskCount > 0
          ? messageStore.runningBackgroundTaskCount
          : undefined,
    })
  }

  // Review Tab: 仅在会话中读取到 Codex 任务变更数据后显示。
  if (uiStore.reviewFiles.length > 0) {
    items.push({
      id: 'review' as const,
      label: '审查',
      icon: GitCompareIcon,
      badge: uiStore.reviewFiles.length,
    })
  }

  // Right Panel Tab Order: 文件固定在最前，Git 固定收在最后；条件 tab 插在两者之间。
  items.push({
    id: 'git' as const,
    label: 'Git',
    icon: GitBranchIcon,
    badge: gitStore.totalChanges > 0 ? gitStore.totalChanges : undefined,
  })

  return items
})

// Conditional Tab Fallback: 条件 tab（后台 / 审查）随数据出现和消失，但 rightPanelTab
// 是独立的持久状态。切会话后当前 tab 的入口没了、内容却还在渲染，用户会盯着一块
// "当前会话没有后台任务"的空面板且没有返回入口。tab 头一旦不含当前选中项就退回文件。
watch(
  tabs,
  (items) => {
    if (items.some((tab) => tab.id === uiStore.rightPanelTab)) return
    uiStore.setRightPanelTab('files')
  },
  { immediate: true },
)
</script>

<style scoped>
.right-panel-titlebar {
  -webkit-app-region: drag;
}

.right-panel-titlebar button {
  -webkit-app-region: no-drag;
}
</style>
