<template>
  <!--
    Catmax 品牌 Logo。

    源素材：assets/catmax-logo.png（黑色坐姿猫咪剪影，透明背景）。
    注意：仓库里的 favicon.svg 路径变换是坏的（渲染出来不像猫），统一用 logo.png。

    variant:
      - "plain"  跟随主题前景色：日间黑猫、夜间白猫。
      - "badge"  深色 #18181b 圆角方块 + 白猫，复刻 App icon，适合独立 Logo 展示。
  -->
  <span
    class="catmax-logo inline-flex items-center justify-center overflow-hidden shrink-0"
    :class="variant === 'badge' ? 'bg-[#18181b] rounded-[22%]' : ''"
  >
    <span
      aria-hidden="true"
      class="catmax-logo__mark block w-full h-full"
      :class="variant === 'badge' ? 'bg-white' : 'bg-foreground'"
      :style="{
        maskImage: `url(${catLogoUrl})`,
        WebkitMaskImage: `url(${catLogoUrl})`,
      }"
    />
  </span>
</template>

<script setup lang="ts">
// 直接 import png，Vite 处理成带 hash 的资源 URL。
import catLogoUrl from '@renderer/assets/catmax-logo.png'

/**
 * Catmax 品牌 Logo。
 *
 * PNG 的透明度作为 mask 使用，因此猫咪轮廓与源图完全一致。
 * - variant="plain"：使用语义前景色，自动显示为日间黑猫 / 夜间白猫。
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

<style scoped>
.catmax-logo__mark {
  mask-position: center;
  mask-repeat: no-repeat;
  mask-size: contain;
  -webkit-mask-position: center;
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-size: contain;
}
</style>
