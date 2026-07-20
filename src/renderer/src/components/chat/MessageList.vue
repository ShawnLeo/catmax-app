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
    <div v-else class="max-w-3xl mx-auto px-6 py-4 flex flex-col gap-6">
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
