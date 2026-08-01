<template>
  <!--
    历史「用户中断」条目——居中胶囊 + 两侧细线，作为回合边界视觉。

    历史回放时 Claude SDK 写入 transcript 的中断 sentinel
    （`[Request interrupted by user]` / `[Request interrupted by user for tool use]`）
    会被 history-mapping 识别，仍构造一条 role:'user' 消息、textBlocks[0].text
    保留 sentinel 原文。MessageItem.vue 在 <article> 外层拦截后交给本组件渲染——
    绕过 user 气泡布局，改用类似 /compact 分隔线的居中标记样式。

    视觉与 CompactDivider 协调（同样的两侧细线 + 居中胶囊骨架），但更克制：
    中断是回合边界，不是会话结构变更，用更小、更淡的字号和更细的图标表达。
  -->
  <div class="flex items-center gap-2.5 my-3 select-none">
    <div class="flex-1 h-px bg-border/40" />
    <div
      class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[length:var(--chat-text-d2)] text-muted-foreground/80 border border-border/40 bg-transparent"
    >
      <CircleSlashIcon class="w-3 h-3" />
      <span>{{ label }}</span>
    </div>
    <div class="flex-1 h-px bg-border/40" />
  </div>
</template>

<script setup lang="ts">
import { CircleSlashIcon } from 'lucide-vue-next'

const props = defineProps<{
  /**
   * 中断变体：
   *   - 'user'：用户停止了整个回合（`[Request interrupted by user]`）
   *   - 'tool'：用户在工具调用时停止（`[Request interrupted by user for tool use]`）
   */
  variant: 'user' | 'tool'
}>()

const label = props.variant === 'tool' ? '用户停止了工具调用' : '用户停止了这一回合'
</script>
