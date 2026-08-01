<template>
  <!--
    内联工具调用渲染——只用于 Read（file_read + title "Read: ..."）。

    跟 ToolCallCard 的区别：
    - 不是卡片（无边框、无 hover 背景）
    - 不可点击展开
    - 单行紧凑显示：icon + 类型名 + 文件名（完整路径 hover 看）
    - 没有状态色点（色点由 MessageItem 时间轴提供）

    用于 Read 工具——输出本来就是文件内容，没必要展开看。
    Glob / Grep 仍走 ToolCallCard（它们是搜索类，展开能看到匹配结果）。
  -->
  <button
    type="button"
    class="flex items-center gap-1.5 text-[length:var(--chat-text-base)] leading-tight hover:text-primary transition-colors"
    :title="`在文件面板中预览 ${fullPath}`"
    @click="openPreview"
  >
    <component
      :is="iconForKind(tool.info.kind)"
      class="w-3.5 h-3.5 text-muted-foreground flex-shrink-0"
    />
    <span class="font-medium text-foreground flex-shrink-0">{{ typeName }}</span>
    <span
      class="text-muted-foreground font-mono truncate min-w-0 hover:text-primary hover:underline"
      >{{ fileName }}</span
    >
  </button>
</template>

<script setup lang="ts">
import { basename } from '@renderer/lib/path'
import { useFilesStore } from '@renderer/stores/files'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type { NormalizedMessage } from '@shared/backend/types'
import { FileSearchIcon } from 'lucide-vue-next'
import { computed } from 'vue'

const props = defineProps<{
  tool: NonNullable<NormalizedMessage['toolBlocks']>[number]
}>()
const filesStore = useFilesStore()
const workspaceStore = useWorkspaceStore()

function iconForKind(kind: string) {
  // Read 用 FileSearchIcon；其他 fallback 同
  if (kind === 'file_read') return FileSearchIcon
  return FileSearchIcon
}

const typeName = computed(() => {
  const m = props.tool.info.title.match(/^(\w+):\s*(.+)$/)
  return m ? m[1]! : 'Read'
})

/** 完整路径——用于 hover tooltip */
const fullPath = computed(() => {
  const m = props.tool.info.title.match(/^\w+:\s*(.+)$/)
  return m ? m[1]! : props.tool.info.title
})

/** 只显示文件名（basename）——路径长时不会被 truncate 截掉关键信息 */
const fileName = computed(() => basename(fullPath.value))

// Chat File Reference: 紧凑 Read 记录点击后打开右侧文件预览，而不是展开工具输出。
async function openPreview(): Promise<void> {
  const workspaceId = workspaceStore.currentWorkspace?.id
  if (!workspaceId) return
  await filesStore.openFileReference(workspaceId, fullPath.value)
}
</script>
