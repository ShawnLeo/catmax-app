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
      <div class="h-10 flex items-end border-b border-border">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          :class="[
            'h-10 w-24 flex items-center justify-center gap-1.5 text-xs font-medium border-b-2 transition-colors',
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
        <button
          type="button"
          class="w-9 h-10 grid place-items-center text-muted-foreground hover:text-foreground hover:bg-muted/40"
          title="关闭右侧面板"
          @click="uiStore.hideRightPanel"
        >
          <XIcon class="w-3.5 h-3.5" />
        </button>
      </div>

      <!-- Tab 内容 -->
      <div class="flex-1 overflow-hidden">
        <GitPanel v-if="uiStore.rightPanelTab === 'git'" />
        <div v-else class="h-full min-w-0 flex">
          <!-- File Preview Split: 预览区固定在文件树左侧；无打开文件时仅保留文件树。 -->
          <FilePreview
            v-if="previewVisible"
            class="shrink-0 border-r border-border"
            :style="{ width: uiStore.filePreviewWidth + 'px' }"
          />
          <FileTree class="shrink-0" :style="{ width: uiStore.rightPanelWidth + 'px' }" />
        </div>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { useFilesStore } from '@renderer/stores/files'
import { useGitStore } from '@renderer/stores/git'
import { useUiStore } from '@renderer/stores/ui'
import { FilesIcon, GitBranchIcon, XIcon } from 'lucide-vue-next'
import { computed } from 'vue'

import FilePreview from './FilePreview.vue'
import FileTree from './FileTree.vue'
import GitPanel from './GitPanel.vue'

const uiStore = useUiStore()
const gitStore = useGitStore()
const filesStore = useFilesStore()

// File Preview Split: 外层面板宽度等于预览区与文件树宽度之和。
const previewVisible = computed(
  () => uiStore.rightPanelTab === 'files' && filesStore.previewTabs.length > 0,
)
const panelWidth = computed(
  () => uiStore.rightPanelWidth + (previewVisible.value ? uiStore.filePreviewWidth : 0),
)

const tabs = computed(() => [
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
])
</script>
