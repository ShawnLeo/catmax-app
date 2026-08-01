<template>
  <aside
    :class="[
      'flex flex-col bg-card shrink-0 overflow-hidden',
      uiStore.panelDragging ? '' : 'transition-[width,border-color] duration-200 ease-out',
      uiStore.rightPanelVisible ? 'border-l border-border' : 'border-l border-transparent',
    ]"
    :style="{ width: uiStore.rightPanelVisible ? panelWidth + 'px' : '0px' }"
    :aria-hidden="!uiStore.rightPanelVisible"
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
          <!-- File Preview Split: 预览区固定在文件树左侧；无打开文件时仅保留文件树。 -->
          <FilePreview
            v-if="previewVisible"
            class="shrink-0"
            :style="{ width: uiStore.filePreviewWidth + 'px' }"
            :show-file-tree-button="!uiStore.fileTreeVisible"
            @show-file-tree="uiStore.setFileTreeVisible(true)"
          />
          <ResizeHandle
            v-if="previewVisible && uiStore.fileTreeVisible"
            side="left"
            :min="FILE_PREVIEW_MIN"
            :max="filePreviewMax"
            :current="uiStore.filePreviewWidth"
            @resize="resizeFilePreview"
            @reach-max="uiStore.setFileTreeVisible(false)"
          />
          <FileTree
            v-if="uiStore.fileTreeVisible || !previewAvailable"
            class="shrink-0"
            :style="{ width: uiStore.rightPanelWidth + 'px' }"
          />
        </div>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
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

const uiStore = useUiStore()
const gitStore = useGitStore()
const filesStore = useFilesStore()
const messageStore = useMessageStore()
const FILE_PREVIEW_MIN = 360
const FILE_TREE_MIN = 240
const SPLIT_HANDLE_WIDTH = 1

// File Preview Split: 外层面板宽度等于预览区与文件树宽度之和。
// Review tab 自带左右 split（文件树 + diff），不叠加 filePreviewWidth，宽度即 rightPanelWidth。
const previewAvailable = computed(() => filesStore.previewTabs.length > 0)
const previewVisible = computed(() => uiStore.rightPanelTab === 'files' && previewAvailable.value)
const panelWidth = computed(() => {
  if (uiStore.rightPanelTab === 'review') return uiStore.rightPanelWidth
  if (uiStore.rightPanelTab !== 'files') return uiStore.rightPanelWidth
  const previewWidth = previewVisible.value ? uiStore.filePreviewWidth : 0
  const treeWidth = uiStore.fileTreeVisible || !previewAvailable.value ? uiStore.rightPanelWidth : 0
  const handleWidth = previewVisible.value && uiStore.fileTreeVisible ? SPLIT_HANDLE_WIDTH : 0
  return previewWidth + treeWidth + handleWidth
})
const filePreviewMax = computed(
  () => uiStore.filePreviewWidth + uiStore.rightPanelWidth - FILE_TREE_MIN,
)

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

async function onTitlebarDoubleClick(event: MouseEvent): Promise<void> {
  // Electron Titlebar: 交互控件不参与窗口放大；仅标题栏空白区域响应双击。
  if ((event.target as HTMLElement).closest('button')) return
  await window.api.system.windowMaximize()
}

const tabs = computed(() => {
  const items: PanelTab[] = [
    {
      id: 'git' as const,
      label: 'Git',
      icon: GitBranchIcon,
      badge: gitStore.totalChanges > 0 ? gitStore.totalChanges : undefined,
    },
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
