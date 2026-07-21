<template>
  <!--
    AskUserQuestion 工具——claude 向用户提问的卡片（历史回放 / 概览用）。

    纯展示：渲染问题和选项列表，不响应点击。
    实时交互走 AskUserQuestionDialog 弹窗（ChatView 顶层挂载，由 messageStore.pendingQuestion 驱动）。

    input.questions 结构（mapping 保留）：
      [{ header, question, multiSelect?, options: [{label, description}] }]
  -->
  <div class="space-y-3 py-1">
    <div v-for="(q, i) in control.questions ?? []" :key="i">
      <div class="flex items-center gap-2 mb-1.5">
        <span
          class="text-[10px] font-mono uppercase tracking-wide text-muted-foreground bg-muted px-1.5 py-0.5 rounded"
        >
          {{ q.header || `Q${i + 1}` }}
        </span>
        <span v-if="q.multiSelect" class="text-[10px] text-muted-foreground">可多选</span>
      </div>
      <div class="text-[13px] font-medium text-foreground mb-1.5">{{ q.question }}</div>
      <div class="flex flex-col gap-1">
        <div
          v-for="(opt, j) in q.options"
          :key="j"
          class="px-2.5 py-1.5 rounded-md border border-border/60 text-[12px] bg-transparent"
        >
          <div class="font-medium text-foreground">{{ opt.label }}</div>
          <div v-if="opt.description" class="text-muted-foreground text-[11px] mt-0.5">
            {{ opt.description }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ToolControlInfo } from '@shared/backend/types'

defineProps<{ control: ToolControlInfo }>()
</script>
