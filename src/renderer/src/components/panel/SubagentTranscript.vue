<template>
  <!--
    Subagent Transcript: 子 Agent 过程的滚动容器。

    单独成组件是因为"贴底"是每个任务各自的状态：多个任务同时展开时，
    一个滚上去看历史不该影响另一个跟着流式输出走。

    chat-font-scope + 覆盖后的 --chat-font-size：子 Agent 过程比主对话小 2px，
    在视觉上把"这是别人跑的内层过程"和主线对话区分开。
  -->
  <div
    ref="scroller"
    class="chat-font-scope max-h-80 overflow-auto rounded border border-border/60 px-2 py-1"
    :style="{ '--chat-font-size': fontSize }"
    @scroll.passive="syncStuck"
  >
    <div ref="content">
      <MessageItem v-for="msg in messages" :key="msg.id" :message="msg" :show-thinking="true" />
    </div>
  </div>
</template>

<script setup lang="ts">
import MessageItem from '@renderer/components/chat/messages/MessageItem.vue'
import { useSettingsStore } from '@renderer/stores/settings'
import type { NormalizedMessage } from '@shared/backend/types'
import { DEFAULT_CHAT_FONT_SIZE } from '@shared/constants'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

defineProps<{ messages: NormalizedMessage[] }>()

const settings = useSettingsStore()

/** 子 Agent 相对主对话缩小的量。 */
const SUBAGENT_FONT_DELTA = 2
/**
 * 下限：刻度里最小的一档是基准 -3px，再往下就不可读了。
 * 主对话已经调到最小时就不再缩，宁可两者同号。
 */
const MIN_CHAT_FONT = 11

/**
 * 这里必须在 JS 里算出绝对 px：
 * `--chat-font-size: calc(var(--chat-font-size) - 2px)` 是自引用循环，CSS 判无效。
 */
const fontSize = computed(() => {
  const base = settings.settings?.theme.chatFontSize ?? DEFAULT_CHAT_FONT_SIZE
  return `${Math.max(MIN_CHAT_FONT, base - SUBAGENT_FONT_DELTA)}px`
})

/**
 * 贴底判定的容差。
 *
 * 不能要求严格等于 0：子像素缩放下 scrollTop + clientHeight 常比 scrollHeight
 * 差零点几个像素，严格判定会让"明明在底部"的容器判成用户已上滑，从此不再跟随。
 */
const BOTTOM_EPSILON = 24

const scroller = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
/** 是否处于"跟随底部"状态。用户主动上滑即脱离，滑回底部重新贴上。 */
const stuck = ref(true)
let observer: ResizeObserver | null = null

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

function syncStuck(): void {
  const el = scroller.value
  if (!el) return
  stuck.value = distanceFromBottom(el) <= BOTTOM_EPSILON
}

function scrollToBottom(): void {
  const el = scroller.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}

onMounted(async () => {
  await nextTick()
  scrollToBottom()
  // 内容高度变化才是"有新输出"的真信号：子 Agent 的流式文本是往已有块里追加的，
  // 只 watch messages 数组会漏掉同一条消息内部的增长。
  if (content.value) {
    observer = new ResizeObserver(() => {
      if (stuck.value) scrollToBottom()
    })
    observer.observe(content.value)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})
</script>
