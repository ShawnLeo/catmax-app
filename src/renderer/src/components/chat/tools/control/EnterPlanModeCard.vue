<template>
  <!--
    EnterPlanMode 工具——claude 进入计划模式。
    input 是 {} 没数据，这里显示一段说明文案。
  -->
  <div class="text-[13px] text-muted-foreground italic py-1">
    进入计划模式。Claude 将探索代码库并提出实施方案，等待你确认后再执行。
  </div>
</template>

<script setup lang="ts">
import type { ToolControlInfo } from '@shared/backend/types'

defineProps<{ control: ToolControlInfo }>()
</script>
