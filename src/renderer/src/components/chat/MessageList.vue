<template>
  <div ref="container" class="h-full overflow-y-auto">
    <div
      v-if="messageStore.loading"
      class="flex items-center justify-center h-full text-muted-foreground"
    >
      <div class="text-center">
        <div class="animate-pulse text-sm">加载历史中...</div>
      </div>
    </div>
    <!--
      响应式宽度（两段式）：
        小窗 <640px   → 跟随窗口（仅 px-6 边距）
        sm ≥640px     → 768px (max-w-3xl)
        lg ≥1024px    → 1024px (max-w-screen-lg)
        xl ≥1280px    → 1280px
        2xl ≥1536px   → 1440px（终极上限，超宽屏不会再变宽）
      mx-auto 居中。Composer 用同样的 class 保持对齐。
    -->
    <div
      v-else
      class="mx-auto px-6 py-4 flex flex-col gap-6 max-w-3xl lg:max-w-screen-lg xl:max-w-[1280px] 2xl:max-w-[1440px]"
    >
      <MessageItem v-for="message in messageStore.messages" :key="message.id" :message="message" />

      <!-- 错误提示（codex/claude 调 API 失败时 messageStore.lastError 会被设置） -->
      <div
        v-if="messageStore.lastError"
        class="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive whitespace-pre-wrap"
      >
        <div class="flex items-start gap-2">
          <AlertCircleIcon class="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div class="flex-1 min-w-0">
            <div class="font-medium mb-1">出错了</div>
            <div class="text-xs">{{ messageStore.lastError }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useMessageStore } from '@renderer/stores/message'
import { AlertCircleIcon } from 'lucide-vue-next'
import { ref, watch, nextTick } from 'vue'

import MessageItem from './MessageItem.vue'

const messageStore = useMessageStore()
const container = ref<HTMLElement | null>(null)

// 流式输出时自动滚到底部
watch(
  () => [messageStore.messages.length, messageStore.lastError],
  async () => {
    await nextTick()
    if (container.value) {
      container.value.scrollTop = container.value.scrollHeight
    }
  },
)
</script>
