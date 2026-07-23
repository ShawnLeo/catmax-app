<template>
  <!--
    通用"加载中"三点动画——三个点依次出现，到 3 个后整体淡出，再循环。

    复用场景：
      - ThinkingBlock header 的 "thinking" 文字后面
      - MessageList 底部的 agent working 指示器

    实现：每个点是独立 span，共享同一套 keyframes（loadcycle），
    用 animation-delay 错开各点的相位——
      第 1 点 0s、第 2 点 0.2s、第 3 点 0.4s。
    keyframes 一轮（1.6s）分三段：
      0%–60% 三个点按 delay 错峰淡入放大（形成"一个个出现"）
      60%–80% 保持全亮
      80%–100% 同步淡出（变没），下一轮再重新一个个出现。

    size / color 通过 props 控制，适配不同使用位置。
  -->
  <span :class="['inline-flex items-center gap-[2px]', $props.class]" aria-hidden="true">
    <span
      v-for="(d, i) in 3"
      :key="i"
      class="block rounded-full bg-current"
      :style="{
        width: dotSize,
        height: dotSize,
        animation: `loadcycle ${duration}s ease-in-out ${i * step}s infinite`,
      }"
    />
  </span>
</template>

<script setup lang="ts">
/**
 * 加载三点动画。
 *
 * @prop dotSize  单个点的宽高（px 数值），默认 3
 * @prop duration 一个完整循环的时长（秒），默认 1.6
 * @prop class    透传 class（颜色用 text-* 控制，点用 currentColor）
 */
import { computed } from 'vue'

const props = withDefaults(defineProps<{ dotSize?: number; duration?: number }>(), {
  dotSize: 3,
  duration: 1.6,
})

// 本地常量——withDefaults 的默认值在 template 里不会被类型收窄（仍可能 undefined），
// 用 const/computed 取出保证模板里拿到的是确定的 number/string。
const dotSize = computed(() => `${props.dotSize}px`)
const duration = computed(() => props.duration)
const step = computed(() => props.duration / 8)
</script>

<style scoped>
/*
  单轮动画（以 duration 为周期，下面比例按 1.6s 计）：
    0%   起点——透明 + 缩小（还没出现）
    30%  完全淡入 + 放大到 1（"出现"动作完成）
    60%  保持全亮（3 个点都到位的稳态期）
    80%  开始同步淡出
    100% 完全消失，下一轮从 0% 重新开始
  各点的 animation-delay 让它们错开相位，视觉上呈现
  "1 个 → 2 个 → 3 个 → 全消失 → 再 1 个..." 的循环。
*/
@keyframes loadcycle {
  0% {
    opacity: 0;
    transform: scale(0.6);
  }
  30% {
    opacity: 1;
    transform: scale(1);
  }
  60% {
    opacity: 1;
    transform: scale(1);
  }
  80% {
    opacity: 0.3;
    transform: scale(0.9);
  }
  100% {
    opacity: 0;
    transform: scale(0.6);
  }
}
</style>
