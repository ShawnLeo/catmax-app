<template>
  <!--
    Image Preview Overlay: 半透明深色背景上用的圆形工具按钮。
    颜色写死成白系——预览遮罩是黑底，主题 token 在这里反而对比不足。
  -->
  <button
    type="button"
    :title="title"
    :disabled="disabled"
    class="inline-flex items-center justify-center rounded-md text-white/90 transition-colors disabled:cursor-not-allowed disabled:opacity-40 hover:bg-white/15 hover:text-white"
    :class="compact ? 'h-8 w-8' : 'h-10 w-10'"
    @click="$emit('click')"
  >
    <slot />
  </button>
</template>

<script setup lang="ts">
defineProps<{
  title?: string
  disabled?: boolean
  compact?: boolean
}>()

defineEmits<{ click: [] }>()
</script>
