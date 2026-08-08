<template>
  <!--
    通用"加载中"三点动画——三个点依次出现（1→2→3），全亮保持一会儿，
    然后三个点同时消失，再重新一个个出现，循环往复，像加载中 gif。

    复用场景：
      - ThinkingBlock header 的 "thinking" 文字后面
      - MessageList 底部的 agent working 指示器

    实现：每个点用各自的 @keyframes（catmax-load-dot-1/2/3），
    不同 keyframes 让三个点"依次点亮"但"同时熄灭"——
      dot1 在 0–20% 淡入
      dot2 在 20–40% 淡入
      dot3 在 40–60% 淡入
      60–75% 三点全亮保持
      75–90% 三点同时淡出
      90–100% 全暗（下一轮重启前的停顿）

    ⚠️ 关键：@keyframes 必须放在**非 scoped** 的 <style> 块里。
    Vue 的 scoped style 会给 @keyframes 加 data-v 哈希重命名，但这里通过
    inline style 的 animation 引用 keyframe 名——inline style 无法引用被重命名
    后的名字，动画会静默失效（点完全不动）。非 scoped + 唯一前缀 catmax- 防冲突。

    点大小默认基于父级字号的 em 缩放，再用 clamp 限制边界；
    size / duration 仍可通过 props 覆盖，适配特殊使用位置。
  -->
  <span
    :class="['inline-flex items-center', $props.class]"
    :style="{ gap: dotGap }"
    aria-hidden="true"
  >
    <span
      v-for="(d, i) in 3"
      :key="i"
      class="block rounded-full bg-current"
      :style="{
        width: dotSize,
        height: dotSize,
        animation: `catmax-load-dot-${i + 1} ${duration}s ease-in-out infinite`,
      }"
    />
  </span>
</template>

<script setup lang="ts">
/**
 * 加载三点动画。
 *
 * @prop dotSize  单个点的宽高；number 按 px，string 可传 CSS length。
 *                默认随父级字号缩放，范围 2.5–4px。
 * @prop duration 一个完整循环的时长（秒），默认 1.6
 * @prop class    透传 class（颜色用 text-* 控制，点用 currentColor）
 */
import { computed } from 'vue'

const RESPONSIVE_DOT_GAP = 'clamp(1.5px, 0.15em, 2.5px)'

const props = withDefaults(defineProps<{ dotSize?: number | string; duration?: number }>(), {
  dotSize: 'clamp(2.5px, 0.23em, 4px)',
  duration: 1.6,
})

// withDefaults 的默认值在 template 里不会被类型收窄（仍可能 undefined），
// 用 computed 取出保证模板里拿到的是确定的 CSS length。
const dotSize = computed(() =>
  typeof props.dotSize === 'number' ? `${props.dotSize}px` : props.dotSize,
)
const dotGap = RESPONSIVE_DOT_GAP
const duration = computed(() => props.duration)
</script>

<!--
  非 scoped：keyframe 名要被 inline style 引用，scoped 会重命名导致失效。
  用 catmax- 前缀避免全局命名冲突。

  三段式周期（以一个 cycle 为 100%）：
    0–20%   dot1 淡入（dot2/dot3 仍暗）
    20–40%  dot2 淡入（dot1 亮，dot3 仍暗）
    40–60%  dot3 淡入（三点全亮）
    60–75%  保持全亮
    75–90%  三点同时淡出
    90–100% 全暗停顿
  这样视觉上呈现 "1 → 2 → 3 → 全消失 → 重新 1..." 的循环。
-->
<style>
@keyframes catmax-load-dot-1 {
  0%,
  90%,
  100% {
    opacity: 0;
    transform: scale(0.6);
  }
  20%,
  75% {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes catmax-load-dot-2 {
  0%,
  20%,
  90%,
  100% {
    opacity: 0;
    transform: scale(0.6);
  }
  40%,
  75% {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes catmax-load-dot-3 {
  0%,
  40%,
  90%,
  100% {
    opacity: 0;
    transform: scale(0.6);
  }
  60%,
  75% {
    opacity: 1;
    transform: scale(1);
  }
}
</style>
