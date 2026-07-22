<template>
  <!--
    根滚动容器——同时是 absolute / sticky 按钮的定位上下文。

    ChatView 给 MessageList 传 class=\"flex-1\"，合并到这个根 div 上。
    flex-1 在 flex-col 父容器里占满剩余高度；min-h-0 让它能正确 shrink
    （flex item 默认 min-height: auto 会撑爆，必须加 min-h-0 才能触发 overflow）。

    悬浮按钮用 sticky 而不是 absolute——sticky 在滚动容器里会贴视口底部，
    不会随内容滚走（absolute 会，fixed 会脱离容器跑到窗口级别）。
  -->
  <div ref="container" class="h-full overflow-y-auto relative min-h-0" @scroll="onScroll">
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
      点击平滑滚到最新消息。

      用 sticky bottom-4——在滚动容器里贴视口底部，不会随内容滚走。
      水平居中（mx-auto + max-w-fit + 左右 margin auto）。
      半透明悬浮效果：bg-background/80 + backdrop-blur + shadow-lg + border，
      hover 时背景更实（bg-background）+ 轻微上浮。
    -->
    <Transition
      enter-active-class="transition-all duration-200 ease-out"
      leave-active-class="transition-all duration-150 ease-in"
      enter-from-class="opacity-0 translate-y-2"
      leave-to-class="opacity-0 translate-y-2"
    >
      <button
        v-if="showScrollToBottom"
        type="button"
        class="sticky bottom-4 mx-auto flex items-center justify-center w-10 h-10 rounded-full border border-border bg-background/80 backdrop-blur-md shadow-lg text-muted-foreground hover:text-foreground hover:bg-background hover:-translate-y-0.5 hover:shadow-xl transition-all"
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
import { onMounted, ref, watch, nextTick, computed } from 'vue'

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

/** 平滑滚到底部（用户点击箭头用） */
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
 *
 * 多次滚策略：MarkdownView 的 renderMarkdown 是异步的（懒加载 markdown-it + Shiki），
 * setMessages 后 messages div 挂载但内容还是空字符串，scrollHeight 不准。
 * 等内容渲染撑开后才有效——分几次滚：
 *   - 立即：messages div 已挂载，布局发生（容器有基础高度）
 *   - rAF：下一帧，Vue patch 完成
 *   - 60ms：markdown 渲染通常 1-2 帧内完成
 *   - 200ms：兜底首次懒加载（markdown-it 模块加载 + Shiki 语法注册）
 */
function snapToBottom(): void {
  if (!container.value) return
  const doScroll = (): void => {
    if (container.value) {
      container.value.scrollTop = container.value.scrollHeight
    }
  }
  doScroll()
  showScrollToBottom.value = false
  requestAnimationFrame(doScroll)
  setTimeout(doScroll, 60)
  setTimeout(doScroll, 200)
}

// 自动滚到底部。
//
// 触发场景：
//   1. 流式输出：messages push 新内容（length 增加）
//   2. 切换 session：currentSessionId 变化 + setMessages 替换数组
//   3. lastError 出现/消失
//   4. loading 变化：loadHistory 时 setLoading(true) 盖住消息列表（v-if loading），
//      setMessages 在 loading=true 期间跑——消息 div 是 v-else 没渲染。
//      setLoading(false) 后消息才挂到 DOM，这时才滚。
//
// ⚠️ ChatView 用 v-if="messages.length > 0" 控制 MessageList 挂载——
// 切到有消息的 session 时组件可能 freshly mounted。watch 默认 immediate=false
// 不会在 mount 时触发，所以额外用 onMounted 兜底滚一次。
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

// mount 时兜底滚一次——处理 v-if fresh mount 场景（watch immediate=false 漏掉）
onMounted(async () => {
  await nextTick()
  snapToBottom()
})
</script>
