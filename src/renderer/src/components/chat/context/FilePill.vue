<template>
  <!--
    IDE 打开文件标签——轻量 pill。

    <ide_opened_file> 只声明"用户在 IDE 里打开了 X"，不带代码内容，
    所以不支持展开——只显示路径，点击复制路径。

    不带自带背景：在 MessageItem 气泡内渲染时由容器统一负责背景。
    仍保留圆角/边框让它在没有气泡包裹时（理论上不会出现，但兼容）也能看。
  -->
  <button
    type="button"
    class="inline-flex items-center gap-1.5 my-0.5 px-1.5 py-0.5 rounded text-muted-foreground text-[length:var(--chat-text-d1)] hover:text-foreground hover:bg-foreground/5 transition-colors font-mono cursor-pointer"
    :title="`在文件面板中预览：${data.filePath}`"
    @click="openPreview"
  >
    <FileIcon class="w-3 h-3 flex-shrink-0" />
    <span class="truncate max-w-[400px]">{{ shortPath }}</span>
  </button>
</template>

<script setup lang="ts">
import { basename } from '@renderer/lib/path'
import { useFilesStore } from '@renderer/stores/files'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type { IdeOpenedFileData } from '@shared/backend/context-tag-types'
import { FileIcon } from 'lucide-vue-next'
import { computed } from 'vue'

const props = defineProps<{ data: IdeOpenedFileData }>()

const filesStore = useFilesStore()
const workspaceStore = useWorkspaceStore()

/** 只显示文件名（basename）——完整路径太长 truncate 会把文件名截没。
 *  完整路径通过外层 button 的 title 属性 hover 可见。
 */
const shortPath = computed(() => basename(props.data.filePath))

// Chat File Reference: IDE 上下文文件也走统一解析，兼容绝对路径和工作区相对路径。
async function openPreview(): Promise<void> {
  const workspaceId = workspaceStore.currentWorkspace?.id
  if (!workspaceId) return
  await filesStore.openFileReference(workspaceId, props.data.filePath)
}
</script>
