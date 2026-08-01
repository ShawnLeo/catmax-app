<template>
  <!--
    /compact 上下文压缩分隔线。

    两态：
      - pending：呼吸动画 "正在压缩上下文"（claude 后台在跑 /compact，可能要十几秒）
      - done：静态 "上下文已压缩"（compact 完成，分隔线上下的对话被压缩隔离）

    视觉上是一条横线 + 居中文案，跟普通消息区分开——它是会话结构分隔符，
    不是对话内容。两侧的细线 + 上下 margin 让它在时间轴里"断开"成两段。
  -->
  <div class="flex items-center gap-3 my-4 select-none">
    <div class="flex-1 h-px bg-border/60" />
    <div
      :class="[
        'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[length:var(--chat-text-base)] font-medium border',
        state === 'pending'
          ? 'text-muted-foreground border-border bg-muted/50 animate-pulse'
          : 'text-muted-foreground/80 border-border/60 bg-transparent',
      ]"
    >
      <component
        :is="state === 'pending' ? Loader2Icon : CheckIcon"
        class="w-3.5 h-3.5"
        :class="state === 'pending' ? 'animate-spin' : ''"
      />
      <span>{{ state === 'pending' ? '正在压缩上下文' : '上下文已压缩' }}</span>
    </div>
    <div class="flex-1 h-px bg-border/60" />
  </div>
</template>

<script setup lang="ts">
import { CheckIcon, Loader2Icon } from 'lucide-vue-next'

defineProps<{
  /** 'pending' = 正在压缩（呼吸动画）；'done' = 已压缩（静态） */
  state: 'pending' | 'done'
}>()
</script>
