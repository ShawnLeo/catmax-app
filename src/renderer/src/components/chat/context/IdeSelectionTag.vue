<template>
  <!--
    IDE 选中代码片段标签——纯展示 chip。

    只显示 <path>:<startLine>-<endLine>，告诉 agent 这条 user 消息引用了哪个文件的
    哪几行。不展示代码内容、不支持展开——catmax 当前不需要展开预览（点击行为已移除），
    保持 chip 轻量。代码内容 agent 侧会自己读文件。
  -->
  <div
    class="inline-flex items-center gap-1.5 text-muted-foreground text-[length:var(--chat-text-d1)] font-mono"
  >
    <TextSelectIcon class="w-3 h-3 flex-shrink-0" />
    <span class="truncate max-w-[400px]" :title="data.filePath">{{ label }}</span>
  </div>
</template>

<script setup lang="ts">
import { basename } from '@renderer/lib/path'
import type { IdeSelectionData } from '@shared/backend/context-tag-types'
import { TextSelectIcon } from 'lucide-vue-next'
import { computed } from 'vue'

const props = defineProps<{ data: IdeSelectionData }>()

/**
 * 展示文案：basename:startLine-endLine。
 *   - 单行：Composer.vue:41-41（claude 原始格式带 to，但 UI 上统一展示起止）
 *   - 多行：Composer.vue:41-50
 * basename 让 chip 紧凑（完整路径在 title 属性里 hover 可见）。
 */
const label = computed(() => {
  const name = basename(props.data.filePath)
  return `${name}:${props.data.startLine}-${props.data.endLine}`
})
</script>
