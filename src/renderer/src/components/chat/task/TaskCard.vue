<template>
  <!--
    Task 工具卡片——子 agent 调用。

    只展示 description + prompt 摘要，不嵌套渲染子 agent 内部 tool calls
    （那需要独立子会话视图，工作量太大；先做摘要版）。

    prompt 可能很长——默认只显示前几行，展开看全部。
  -->
  <div class="space-y-1.5 py-0.5">
    <!-- description -->
    <div class="flex items-center gap-1.5 text-[13px]">
      <BotIcon class="w-3.5 h-3.5 text-primary flex-shrink-0" />
      <span class="font-medium text-foreground">{{ task.description }}</span>
    </div>

    <!-- prompt（可折叠） -->
    <div v-if="task.prompt" class="pl-5">
      <pre
        class="font-mono text-[12px] text-muted-foreground whitespace-pre-wrap break-words leading-relaxed"
        :class="expanded ? '' : 'line-clamp-3'"
        >{{ task.prompt }}</pre
      >
      <button
        v-if="task.prompt.split('\n').length > 3 || task.prompt.length > 200"
        class="text-[11px] text-primary hover:underline mt-1"
        @click="expanded = !expanded"
      >
        {{ expanded ? '收起' : '展开全部' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ToolTaskInfo } from '@shared/backend/types'
import { BotIcon } from 'lucide-vue-next'
import { ref } from 'vue'

defineProps<{ task: ToolTaskInfo }>()

const expanded = ref(false)
</script>

<style scoped>
.line-clamp-3 {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
