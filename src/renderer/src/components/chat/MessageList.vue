<template>
  <div ref="container" class="h-full overflow-y-auto relative" @scroll="onScroll">
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

    <!--
      悬浮"回到底部"箭头：用户向上滚离底部超过阈值（120px）时显示，
      点击平滑滚到最新消息。贴容器右下角，半透明背景 + 圆形按钮，
      跟 Composer 输入框留出间距（bottom-20 避免被遮挡）。
    -->
    <Transition
      enter-active-class="transition-opacity duration-150"
      leave-active-class="transition-opacity duration-150"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <button
        v-if="showScrollToBottom"
        type="button"
        class="absolute bottom-20 right-6 z-10 w-9 h-9 flex items-center justify-center rounded-full border border-border bg-background/90 backdrop-blur shadow-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        title="回到底部"
        @click="scrollToBottom"
      >
        <ArrowDownIcon class="w-4 h-4" />
      </button>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { useMessageStore } from '@renderer/stores/message'
import { AlertCircleIcon, ArrowDownIcon } from 'lucide-vue-next'
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

/**
 * 是否显示"回到底部"箭头。
 * 判据：距离底部超过 SCROLL_THRESHOLD（120px）时显示。
 * 贴近底部（流式自动滚动 / 用户已看到最新）时隐藏。
 */
const showScrollToBottom = ref(false)
const SCROLL_THRESHOLD = 120

/** 滚动事件——计算是否离底部足够远，决定显示/隐藏箭头 */
function onScroll(): void {
  if (!container.value) return
  const { scrollTop, scrollHeight, clientHeight } = container.value
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight
  showScrollToBottom.value = distanceFromBottom > SCROLL_THRESHOLD
}

/** 平滑滚到底部 */
function scrollToBottom(): void {
  if (!container.value) return
  container.value.scrollTo({
    top: container.value.scrollHeight,
    behavior: 'smooth',
  })
}

/**
 * 程式化滚到底部（无动画，给自动滚动用）。
 * 滚完后同步更新 showScrollToBottom（贴底了 → 隐藏箭头）。
 */
function snapToBottom(): void {
  if (!container.value) return
  container.value.scrollTop = container.value.scrollHeight
  showScrollToBottom.value = false
}

// 自动滚到底部，四种触发：
//   1. 流式输出时：messages 数组 push 新内容（length 增加）
//   2. 切换 session：setMessages 替换数组引用 + currentSessionId 变化
//      光靠 length 会被"新旧 session 消息数相同"场景漏掉（5 → 5 不触发），
//      所以同时 watch currentSessionId 强制滚一次。
//   3. lastError 变化：错误提示出现/消失时也对齐底部
//   4. loading 变化：loadHistory 时 setLoading(true) 会盖住消息列表（v-if loading），
//      setMessages 在 loading=true 期间跑——此时消息 div 是 v-else 没渲染，
//      滚动无效。setLoading(false) 后消息才挂到 DOM，这时才需要滚。
//      必须在 loading=false 时滚，否则容器里没内容。
watch(
  () => [
    messageStore.messages.length,
    messageStore.currentSessionId,
    messageStore.lastError,
    messageStore.loading,
  ],
  async () => {
    // loading 中不滚——消息列表被 loading overlay 盖住，滚了也看不到
    if (messageStore.loading) return
    await nextTick()
    snapToBottom()
  },
)
</script>
