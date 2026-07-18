<template>
  <article class="flex gap-3">
    <!-- 头像 -->
    <div
      :class="[
        'flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium',
        message.role === 'user'
          ? 'bg-secondary text-secondary-foreground'
          : 'bg-primary text-primary-foreground',
      ]"
    >
      {{ avatarLabel }}
    </div>

    <div class="flex-1 min-w-0">
      <header class="flex items-baseline gap-2 mb-1">
        <span class="font-sans text-sm font-medium text-foreground">{{ authorName }}</span>
      </header>

      <!-- 文本块 -->
      <MarkdownView
        v-for="block in message.textBlocks"
        :key="block.id"
        :text="block.text"
        :class="[
          'font-chat leading-relaxed text-[15px]',
          block.kind === 'reasoning' ? 'text-muted-foreground italic' : 'text-foreground',
        ]"
      />

      <!-- 工具调用块 -->
      <ToolCallCard v-for="tool in message.toolBlocks" :key="tool.id" :tool="tool" class="mt-2" />
    </div>
  </article>
</template>

<script setup lang="ts">
import type { NormalizedMessage } from '@shared/backend/types'
import { computed } from 'vue'

import MarkdownView from './MarkdownView.vue'
import ToolCallCard from './ToolCallCard.vue'

const props = defineProps<{ message: NormalizedMessage }>()

const authorName = computed(() => (props.message.role === 'user' ? 'You' : 'Codex'))
const avatarLabel = computed(() => (props.message.role === 'user' ? 'Y' : '◆'))
</script>
