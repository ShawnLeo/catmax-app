<template>
  <!--
    思考（reasoning）块——可折叠披露组件，替换原本内联的斜体灰文。

    两态：
      - streaming（实时）：header 显示 "thinking" + 三点渐进式加载动画
        （1→2→3 个点依次出现，到 3 个后整体淡出，循环往复，像加载中 gif），
        文字本身带轻微呼吸效果。内容默认折叠。
      - done（完成）：header 显示 "已思考 ▾"，默认折叠，点击展开看完整推理。

    默认始终折叠——思考内容对快速阅读是噪音，需要时再点开。
    streaming 态下文案 + 动画本身就是"正在思考"的视觉信号，
    不需要额外 spinner。
  -->
  <div class="my-0.5">
    <!-- header：点击切换展开/收起 -->
    <button
      type="button"
      class="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[length:var(--chat-text-d1)] transition-colors hover:bg-accent/50 text-muted-foreground cursor-pointer"
      :title="streaming ? '正在思考...' : '点击展开/收起推理'"
      @click="open = !open"
    >
      <BrainIcon
        class="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground"
        :class="streaming ? 'animate-pulse' : ''"
      />

      <!-- streaming：呼吸的 "thinking" 文字 + 三点渐进式加载动画 -->
      <template v-if="streaming">
        <span class="animate-[thinkbreath_1.6s_ease-in-out_infinite]">thinking</span>
        <LoadingDots class="ml-0.5 text-muted-foreground" :dot-size="3" :duration="1.6" />
      </template>

      <!-- done：静态文案 + 耗时（如有）+ 折叠箭头 -->
      <template v-else>
        <span>{{ completedLabel ?? '已思考' }}</span>
        <span v-if="durationLabel" class="text-muted-foreground/70 tabular-nums">{{
          durationLabel
        }}</span>
        <ChevronDownIcon
          class="w-3 h-3 flex-shrink-0 transition-transform"
          :class="open ? 'rotate-180' : ''"
        />
      </template>
    </button>

    <!-- 展开内容：斜体灰文，跟原本内联样式一致 -->
    <div
      v-if="open"
      class="mt-1 pl-2 border-l border-border/40 text-muted-foreground italic leading-relaxed text-[length:var(--chat-text-u1)]"
    >
      <MarkdownView v-if="text.trim()" :text="text" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { BrainIcon, ChevronDownIcon } from 'lucide-vue-next'
import { computed, ref } from 'vue'

import MarkdownView from '../blocks/base/MarkdownView.vue'

import LoadingDots from './LoadingDots.vue'

const props = defineProps<{
  /** reasoning 文本（可能是部分流式 token，会随时间增长） */
  text: string
  /** 是否处于实时流式状态——true 时 header 显示动画 thinking... */
  streaming: boolean
  /** 思考耗时（秒）。null = 拿不到（历史消息反推无时间戳）→ 不显示 */
  durationSec?: number | null
  /** 完成态标题；Codex 历史使用“已处理”。 */
  completedLabel?: string | undefined
}>()

/** 折叠态——默认始终折叠（用户主动点开才看） */
const open = ref(false)

/**
 * 耗时展示文案：
 *   - < 1s   → "<1s"（思考极快时避免显示 0s 这种尴尬值）
 *   - < 60s  → "Ns"
 *   - ≥ 60s  → "Nm Ns"
 * 拿不到 durationSec 时不显示（返回空串）。
 */
const durationLabel = computed(() => {
  const sec = props.durationSec
  if (sec === undefined || sec === null) return ''
  if (sec < 1) return '<1s'
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}m ${s}s`
})
</script>

<style scoped>
/* "thinking" 文字的轻微呼吸——opacity 0.5 → 1 循环，跟三点动画同节奏 */
@keyframes thinkbreath {
  0%,
  100% {
    opacity: 0.5;
  }
  50% {
    opacity: 1;
  }
}
</style>
