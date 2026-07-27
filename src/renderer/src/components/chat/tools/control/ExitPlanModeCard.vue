<template>
  <!--
    ExitPlanMode 工具——claude 退出计划模式 + 提交方案。
    input.plan 是 markdown 实施方案——用户审批的核心内容。
  -->
  <div>
    <div class="text-[12px] text-muted-foreground mb-2 flex items-center gap-1.5">
      <ClipboardCheckIcon class="w-3 h-3" />
      <span>已退出计划模式，方案如下：</span>
    </div>
    <MarkdownView v-if="control.plan" :text="control.plan" class="text-[14px] text-foreground" />
    <div v-else class="text-[13px] text-muted-foreground italic">（无方案内容）</div>
  </div>
</template>

<script setup lang="ts">
import type { ToolControlInfo } from '@shared/backend/types'
import { ClipboardCheckIcon } from 'lucide-vue-next'

import MarkdownView from '../../blocks/base/MarkdownView.vue'

defineProps<{ control: ToolControlInfo }>()
</script>
