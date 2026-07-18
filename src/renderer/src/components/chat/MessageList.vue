<template>
  <div ref="container" class="h-full overflow-y-auto">
    <div class="max-w-3xl mx-auto px-6 py-4 flex flex-col gap-6">
      <MessageItem v-for="message in messageStore.messages" :key="message.id" :message="message" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { useMessageStore } from '@renderer/stores/message'
import { ref, watch, nextTick } from 'vue'

import MessageItem from './MessageItem.vue'

const messageStore = useMessageStore()
const container = ref<HTMLElement | null>(null)

// 流式输出时自动滚到底部
watch(
  () => messageStore.messages.length,
  async () => {
    await nextTick()
    if (container.value) {
      container.value.scrollTop = container.value.scrollHeight
    }
  },
)
</script>
