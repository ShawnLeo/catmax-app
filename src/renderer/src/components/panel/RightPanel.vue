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
        <button
          v-for="tab in tabs"
          :key="tab.id"
          :class="[
            'h-12 w-24 flex items-center justify-center gap-1.5 text-xs font-medium border-b-2 transition-colors',
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
            class="min-w-4 h-4 px-1 rounded-full bg-muted text-[10px] grid place-items-center"
          >
            {{ tab.badge }}
          </span>
        </button>
        <div class="flex-1" />
        <!-- Files Split Controls: 两侧独立显隐，但始终至少保留一个面板。 -->
        <template v-if="uiStore.rightPanelTab === 'files'">
          <button
            type="button"
            :class="[
              'w-9 h-12 grid place-items-center hover:bg-muted/40',
              previewAvailable && uiStore.filePreviewVisible
                ? 'text-foreground'
                : 'text-muted-foreground',
            ]"
            :disabled="
              !previewAvailable || (uiStore.filePreviewVisible && !effectiveFileTreeVisible)
            "
            :title="
              !previewAvailable
                ? '打开文件后可显示文件详情'
                : uiStore.filePreviewVisible && !effectiveFileTreeVisible
                  ? '至少保留一个面板'
                  : uiStore.filePreviewVisible
                    ? '关闭文件详情'
                    : '显示文件详情'
            "
            @click="toggleFilePreview"
          >
            <PanelLeftIcon class="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            :class="[
              'w-9 h-12 grid place-items-center hover:bg-muted/40',
              effectiveFileTreeVisible ? 'text-foreground' : 'text-muted-foreground',
            ]"
            :disabled="effectiveFileTreeVisible && !previewVisible"
            :title="
              effectiveFileTreeVisible && !previewVisible
                ? '至少保留一个面板'
                : effectiveFileTreeVisible
                  ? '关闭文件树'
                  : '显示文件树'
            "
            @click="toggleFileTree"
          >
            <PanelRightIcon class="w-3.5 h-3.5" />
          </button>
        </template>
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
        <div v-else class="h-full min-w-0 flex">
          <!-- File Preview Split: 预览区固定在文件树左侧；无打开文件时仅保留文件树。 -->
          <FilePreview
            v-if="previewVisible"
            class="shrink-0"
            :style="{ width: uiStore.filePreviewWidth + 'px' }"
          />
          <ResizeHandle
            v-if="previewVisible && effectiveFileTreeVisible"
            side="left"
            :min="FILE_PREVIEW_MIN"
            :max="filePreviewMax"
            :current="uiStore.filePreviewWidth"
            @resize="resizeFilePreview"
            @reach-min="uiStore.setFilePreviewVisible(false)"
            @reach-max="uiStore.setFileTreeVisible(false)"
          />
          <FileTree
            v-if="effectiveFileTreeVisible"
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
import { type RightPanelTab, useUiStore } from '@renderer/stores/ui'
import {
  FilesIcon,
  GitBranchIcon,
  GitCompareIcon,
  PanelLeftIcon,
  PanelRightIcon,
  XIcon,
} from 'lucide-vue-next'
import { computed, type Component } from 'vue'

import ResizeHandle from '../ui/ResizeHandle.vue'

import FilePreview from './FilePreview.vue'
import FileTree from './FileTree.vue'
import GitPanel from './GitPanel.vue'
import ReviewPanel from './ReviewPanel.vue'

const uiStore = useUiStore()
const gitStore = useGitStore()
const filesStore = useFilesStore()
const FILE_PREVIEW_MIN = 360
const FILE_TREE_MIN = 240
const SPLIT_HANDLE_WIDTH = 1

// File Preview Split: 外层面板宽度等于预览区与文件树宽度之和。
// Review tab 自带左右 split（文件树 + diff），不叠加 filePreviewWidth，宽度即 rightPanelWidth。
const previewAvailable = computed(() => filesStore.previewTabs.length > 0)
// 没有已打开文件时强制保留文件树，否则 Files 页会失去内容与恢复入口。
const effectiveFileTreeVisible = computed(() => uiStore.fileTreeVisible || !previewAvailable.value)
const previewVisible = computed(
  () => uiStore.rightPanelTab === 'files' && previewAvailable.value && uiStore.filePreviewVisible,
)
const panelWidth = computed(() => {
  if (uiStore.rightPanelTab === 'review') return uiStore.rightPanelWidth
  if (uiStore.rightPanelTab !== 'files') return uiStore.rightPanelWidth
  const previewWidth = previewVisible.value ? uiStore.filePreviewWidth : 0
  const treeWidth = effectiveFileTreeVisible.value ? uiStore.rightPanelWidth : 0
  const handleWidth =
    previewVisible.value && effectiveFileTreeVisible.value ? SPLIT_HANDLE_WIDTH : 0
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
  const combinedWidth = uiStore.filePreviewWidth + uiStore.rightPanelWidth
  uiStore.setFilePreviewWidth(width)
  uiStore.setRightPanelWidth(combinedWidth - width)
}

function toggleFilePreview(): void {
  if (!previewAvailable.value) return
  uiStore.setFilePreviewVisible(!uiStore.filePreviewVisible)
}

function toggleFileTree(): void {
  uiStore.setFileTreeVisible(!uiStore.fileTreeVisible)
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
      label: 'Files',
      icon: FilesIcon,
      badge: undefined,
    },
  ]

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
</script>

<style scoped>
.right-panel-titlebar {
  -webkit-app-region: drag;
}

.right-panel-titlebar button {
  -webkit-app-region: no-drag;
}
</style>
