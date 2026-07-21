<template>
  <!--
    Composer 上方的附件列表。展示 pending attachments，每条带 ✕ 移除按钮。

    当前支持 ide_selection 类型——按 tag 分发展示（跟 MessageItem 的 contextBlocks 渲染对齐）。
    加新附件类型在 AttachmentItem.vue（或本文件内的 v-if 分支）扩展。
  -->
  <div v-if="attachments.length > 0" class="flex flex-wrap gap-1.5 px-4 pt-3">
    <div
      v-for="(att, i) in attachments"
      :key="i"
      class="group inline-flex items-center gap-1.5 pl-2 pr-1 py-0.5 rounded-md bg-muted text-muted-foreground text-[12px] max-w-full"
    >
      <TextSelectIcon class="w-3 h-3 flex-shrink-0" />
      <span class="truncate max-w-[280px]">{{ describe(att) }}</span>
      <button
        type="button"
        class="flex-shrink-0 p-0.5 rounded hover:bg-muted-foreground/20 hover:text-foreground transition-colors"
        title="移除"
        aria-label="移除附件"
        @click="$emit('remove', i)"
      >
        <XIcon class="w-3 h-3" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { IdeSelectionData } from '@shared/backend/context-tag-types'
import type { ContextBlock } from '@shared/backend/types'
import { TextSelectIcon, XIcon } from 'lucide-vue-next'

defineProps<{ attachments: ContextBlock[] }>()
defineEmits<{ remove: [index: number] }>()

/** 给附件一个简短描述。按 tag 分发，加新 tag 在这里加 case。 */
function describe(att: ContextBlock): string {
  switch (att.tag) {
    case 'ide_selection': {
      const d = att.data as IdeSelectionData
      const n = d.endLine - d.startLine + 1
      return `${d.filePath}:${d.startLine}-${d.endLine} (${n} 行)`
    }
    default:
      return att.tag
  }
}
</script>
