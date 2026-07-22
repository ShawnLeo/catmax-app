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
      <MessageItem
        v-for="message in messageStore.messages"
        :key="message.id"
        :message="message"
        :show-thinking="showThinking"
      />

      <!--
        /compact 分隔线：用户发 /compact 时不展示 /compact 消息气泡，
        改为在消息流末尾插入这条分隔线。
        - pending（呼吸）：claude 后台正在压缩上下文
        - done（静态）：压缩完成，分隔线上下的对话被压缩隔离
        compactState 由 messageStore 跟踪（turn_completed 自动切 pending → done）。
      -->
      <CompactDivider v-if="messageStore.compactState" :state="messageStore.compactState" />

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
import { ref, watch, nextTick, computed } from 'vue'

import CompactDivider from './CompactDivider.vue'
import MessageItem from './MessageItem.vue'

const props = defineProps<{
  /** 是否显示思考块（reasoning）。OFF 时 MessageItem 折叠 kind='reasoning' 的 textBlocks。 */
  showThinking?: boolean
}>()
const showThinking = computed(() => props.showThinking ?? true)

const messageStore = useMessageStore()
const container = ref<HTMLElement | null>(null)

// 自动滚到底部，三种触发：
//   1. 流式输出时：messages 数组 push 新内容（length 增加）
//   2. 切换 session：setMessages 替换数组引用 + currentSessionId 变化
//      光靠 length 会被"新旧 session 消息数相同"场景漏掉（5 → 5 不触发），
//      所以同时 watch currentSessionId 强制滚一次。
//   3. lastError 变化：错误提示出现/消失时也对齐底部
//
// 时序：selectSession 先 setCurrentSession（触发 watch），再 await loadHistory
// （setMessages 触发第二次 watch）。第二次 watch 时新消息已渲染，滚动才有效。
watch(
  () => [messageStore.messages.length, messageStore.currentSessionId, messageStore.lastError],
  async () => {
    await nextTick()
    if (container.value) {
      container.value.scrollTop = container.value.scrollHeight
    }
  },
)
</script>
