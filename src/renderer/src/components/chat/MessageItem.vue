<template>
  <!--
    消息项布局：
    - user：靠右，圆角气泡（primary 配色），无头像
    - assistant：靠左，无气泡，无特殊字体（保持 MarkdownView 默认），左侧色条头像
  -->
  <article :class="['flex gap-3', message.role === 'user' ? 'flex-row-reverse' : 'flex-row']">
    <!-- 头像（仅 assistant） -->
    <div
      v-if="message.role === 'assistant'"
      class="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium bg-primary text-primary-foreground"
    >
      ◆
    </div>

    <!-- 消息体 -->
    <div :class="['min-w-0', message.role === 'user' ? 'max-w-[80%]' : 'flex-1']">
      <!-- 作者名（仅 assistant；user 不显示，气泡自带辨识） -->
      <header v-if="message.role === 'assistant'" class="flex items-baseline gap-2 mb-1">
        <span class="font-sans text-sm font-medium text-foreground">{{ authorName }}</span>
      </header>

      <!-- 文本块 -->
      <!--
        user：用气泡包裹（bg-primary / text-primary-foreground + 圆角内边距）。
        assistant：不裹气泡，平铺渲染，沿用 MarkdownView 默认字体。
        reasoning 块：两种角色都用 muted + italic 弱化展示。
      -->
      <div
        v-for="block in message.textBlocks"
        :key="block.id"
        :class="[
          message.role === 'user' && block.kind !== 'reasoning'
            ? 'rounded-2xl px-4 py-2 bg-primary text-primary-foreground break-words'
            : '',
          message.role === 'assistant' && block.kind === 'reasoning'
            ? 'text-muted-foreground italic'
            : '',
          message.role === 'user' && block.kind === 'reasoning'
            ? 'rounded-2xl px-4 py-2 bg-secondary text-muted-foreground italic'
            : '',
        ]"
      >
        <MarkdownView
          :text="block.text"
          :class="[
            'leading-relaxed text-[15px]',
            // user 气泡内强制继承 primary-foreground 文本色
            message.role === 'user' && block.kind !== 'reasoning' ? 'text-inherit' : '',
          ]"
        />
      </div>

      <!-- 工具调用块 -->
      <ToolCallCard v-for="tool in message.toolBlocks" :key="tool.id" :tool="tool" class="mt-2" />
    </div>
  </article>
</template>

<script setup lang="ts">
import { useBackendStore } from '@renderer/stores/backend'
import type { NormalizedMessage } from '@shared/backend/types'
import { computed } from 'vue'

import MarkdownView from './MarkdownView.vue'
import ToolCallCard from './ToolCallCard.vue'

const props = defineProps<{ message: NormalizedMessage }>()

const backendStore = useBackendStore()

/**
 * assistant 的作者名取当前后端 id（codex / claude），首字母大写。
 * 之前硬编码为 'Codex'，切到 claude 后端时显示是错的。
 */
const authorName = computed(() => {
  const id = backendStore.currentId ?? 'assistant'
  return id.charAt(0).toUpperCase() + id.slice(1)
})
</script>
