<template>
  <!--
    Composer 上方的附件列表。展示待发送的引用，每条带 ✕ 移除按钮。

    两组来源不同，删除语义也不同，所以分开渲染而不是合成一个数组：

    - 文件引用（fileMentions）：派生自输入框文本里的 `@路径`，没有独立状态。
      点 ✕ 实际是把那段文本删掉，所以手删文本和点 ✕ 永远是一回事。
    - 选区片段（attachments）：带代码正文，文本里表达不出来，只能单独存着。

    加新的带正文附件类型在 describe() 里加 case。
  -->
  <div
    v-if="fileMentions.length > 0 || attachments.length > 0"
    class="flex flex-wrap gap-1.5 px-4 pt-3"
  >
    <!--
      key 用路径而不是 start 偏移：偏移会随前面的文字增删不断变化，用它当 key
      等于每敲一个字符就把所有 pill 重新挂载一遍，刚取到的缩略图会被反复丢弃。
      路径在这份列表里已经去过重（见 chat-input store 的 fileMentions）。
    -->
    <FileMentionPill
      v-for="mention in fileMentions"
      :key="mention.path"
      :mention="mention"
      @remove="$emit('removeMention', mention)"
    />

    <div
      v-for="(att, i) in attachments"
      :key="`att-${i}`"
      class="group inline-flex items-center gap-1.5 pl-2 pr-1 py-0.5 rounded-md bg-muted text-muted-foreground text-[length:var(--chat-text-d1)] max-w-full"
    >
      <TextSelectIcon class="w-3 h-3 flex-shrink-0" />
      <span class="truncate max-w-[280px]">{{ describe(att) }}</span>
      <button
        type="button"
        class="flex-shrink-0 p-0.5 rounded hover:bg-muted-foreground/20 hover:text-foreground transition-colors cursor-pointer"
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
import FileMentionPill from '@renderer/components/chat/composer/FileMentionPill.vue'
import type { FileMention } from '@renderer/lib/file-mention'
import type { IdeSelectionData } from '@shared/backend/context-tag-types'
import type { ContextBlock } from '@shared/backend/types'
import { TextSelectIcon, XIcon } from 'lucide-vue-next'

defineProps<{ attachments: ContextBlock[]; fileMentions: FileMention[] }>()
defineEmits<{ remove: [index: number]; removeMention: [mention: FileMention] }>()

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
