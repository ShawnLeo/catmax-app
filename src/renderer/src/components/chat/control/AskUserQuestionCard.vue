<template>
  <!--
    AskUserQuestion 工具——claude 向用户提问。
    input.questions 是 [{header, question, options:[{label, description}]}]
    渲染每个问题 + 选项卡片网格。

    历史回放时用户当时选了哪个不在 input 里（在后续 user message），
    所以这里只展示问题和选项，不展示选择结果。
  -->
  <div class="space-y-3 py-1">
    <div v-for="(q, i) in control.questions ?? []" :key="i">
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
