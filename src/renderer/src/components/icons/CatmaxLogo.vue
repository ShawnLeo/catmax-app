<template>
  <!--
    Catmax 品牌 Logo。

    源素材：assets/catmax-logo.png（黑色坐姿猫咪剪影，透明背景）。
    注意：仓库里的 favicon.svg 路径变换是坏的（渲染出来不像猫），统一用 logo.png。

    variant:
      - "plain"  纯白猫剪影（黑猫经 invert 反相），适合叠在深色/有色背景上。
      - "badge"  深色 #18181b 圆角方块 + 白猫，复刻 App icon，适合独立 Logo 展示。
  -->
  <span
    class="catmax-logo inline-flex items-center justify-center overflow-hidden shrink-0"
    :class="variant === 'badge' ? 'bg-[#18181b] rounded-[22%]' : ''"
  >
    <img
      :src="catLogoUrl"
      alt=""
      aria-hidden="true"
      class="catmax-logo__img w-full h-full object-contain invert select-none"
      draggable="false"
    />
  </span>
</template>

<script setup lang="ts">
// 直接 import png，Vite 处理成带 hash 的资源 URL。
import catLogoUrl from '@renderer/assets/catmax-logo.png'

/**
 * Catmax 品牌 Logo。
 *
 * 源图是黑色猫剪影，用 Tailwind `invert` 反相成白猫。
 * - variant="plain"：纯白猫，父元素给深色背景即可见。
 * - variant="badge"：自带深色圆角方块 + 白猫（复刻 App icon）。
 */
withDefaults(
  defineProps<{
    variant?: 'plain' | 'badge'
  }>(),
  {
    variant: 'plain',
  },
)
</script>
