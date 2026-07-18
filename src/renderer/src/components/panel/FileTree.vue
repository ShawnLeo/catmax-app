<template>
  <div class="h-full flex flex-col">
    <!-- 文件树 -->
    <div class="flex-1 overflow-y-auto p-2">
      <div
        v-if="!workspaceStore.currentWorkspace"
        class="text-center text-xs text-muted-foreground py-8"
      >
        请先选择工作区
      </div>
      <FileTreeNode
        v-else
        :workspace-path="workspaceStore.currentWorkspace.path"
        :workspace-id="workspaceStore.currentWorkspace.id"
        relative-path=""
        :depth="0"
      />
    </div>

    <!-- 文件预览（底部） -->
    <FilePreview v-if="filesStore.currentPreview" class="border-t border-border h-64" />
  </div>
</template>

<script setup lang="ts">
import { useFilesStore } from '@renderer/stores/files'
import { useWorkspaceStore } from '@renderer/stores/workspace'

import FilePreview from './FilePreview.vue'
import FileTreeNode from './FileTreeNode.vue'

const workspaceStore = useWorkspaceStore()
const filesStore = useFilesStore()
</script>
