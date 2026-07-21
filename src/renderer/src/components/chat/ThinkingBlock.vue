<template>
  <!--
    思考（reasoning）块——可折叠披露组件，替换原本内联的斜体灰文。

    两态：
      - streaming（实时）：header 显示动态 "thinking..."（灰白呼吸 + 三个错峰动画点），
        内容默认折叠。用户可点击展开看实时输出的推理过程。
      - done（完成）：header 显示 "已思考 ▾"，默认折叠，点击展开看完整推理。

    默认始终折叠——思考内容对快速阅读是噪音，需要时再点开。
    streaming 态下文案是动画的，本身就是"正在思考"的视觉信号，
    不需要额外 spinner。
  -->
  <div class="my-0.5">
    <!-- header：点击切换展开/收起 -->
    <button
      type="button"
      class="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] transition-colors hover:bg-accent/50 text-muted-foreground"
      :title="streaming ? '正在思考...' : '点击展开/收起推理'"
      @click="open = !open"
    >
      <BrainIcon class="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" />

      <!-- streaming：动态 thinking... 文字 + 三个错峰呼吸的灰点 -->
      <template v-if="streaming">
        <span>thinking</span>
        <span class="inline-flex items-center gap-[2px] ml-0.5">
          <span
            class="block w-[3px] h-[3px] rounded-full bg-muted-foreground animate-[thinkdot_1.2s_ease-in-out_infinite]"
          />
          <span
            class="block w-[3px] h-[3px] rounded-full bg-muted-foreground animate-[thinkdot_1.2s_ease-in-out_infinite_0.2s]"
          />
          <span
            class="block w-[3px] h-[3px] rounded-full bg-muted-foreground animate-[thinkdot_1.2s_ease-in-out_infinite_0.4s]"
          />
        </span>
      </template>

      <!-- done：静态文案 + 耗时（如有）+ 折叠箭头 -->
      <template v-else>
        <span>已思考</span>
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
      class="mt-1 pl-2 border-l border-border/40 text-muted-foreground italic leading-relaxed text-[14px]"
    >
      <MarkdownView v-if="text.trim()" :text="text" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { BrainIcon, ChevronDownIcon } from 'lucide-vue-next'
import { computed, ref } from 'vue'

import MarkdownView from './MarkdownView.vue'

const props = defineProps<{
  /** reasoning 文本（可能是部分流式 token，会随时间增长） */
  text: string
  /** 是否处于实时流式状态——true 时 header 显示动画 thinking... */
  streaming: boolean
  /** 思考耗时（秒）。null = 拿不到（历史消息反推无时间戳）→ 不显示 */
  durationSec?: number | null
}>()

/** 折叠态——默认始终折叠（用户主动点开才看） */
const open = ref(false)

/**
 * 耗时展示文案：
 *   - < 1s   → "<1s"（思考极快时避免显示 0s 这种尴尬值）
 *   - < 60s  → "Ns"
 *   - ≥ 60s  → "N分Ss"
 * 拿不到 durationSec 时不显示（返回空串）。
 */
const durationLabel = computed(() => {
  const sec = props.durationSec
  if (sec === undefined || sec === null) return ''
  if (sec < 1) return '<1s'
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}分${s}s`
})
</script>

<style scoped>
/* 三个点的错峰呼吸动画——opacity 0.2 → 1 → 0.2 循环 */
@keyframes thinkdot {
  0%,
  100% {
    opacity: 0.2;
    transform: scale(0.8);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}
</style>
