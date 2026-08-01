<template>
  <!--
    TodoWrite 工具——claude 更新任务清单。
    input.todos 是 [{content, status, activeForm}]
    渲染成 todo list：
      ✓ 已完成（绿色对勾 + 删除线）
      ● 进行中（品牌色脉冲点 + activeForm 优先显示）
      ○ 待办（灰色空圆）
  -->
  <ul class="space-y-1.5 py-0.5">
    <li
      v-for="(todo, i) in control.todos ?? []"
      :key="i"
      class="flex items-start gap-2 text-[length:var(--chat-text-base)] leading-relaxed"
    >
      <!-- 状态图标 -->
      <span class="flex-shrink-0 mt-0.5">
        <CheckIcon v-if="todo.status === 'completed'" class="w-3.5 h-3.5 text-success" />
        <span
          v-else-if="todo.status === 'in_progress'"
          class="block w-2 h-2 rounded-full bg-primary animate-pulse mt-0.5"
        />
        <CircleIcon v-else class="w-3.5 h-3.5 text-muted-foreground" />
      </span>
      <!-- 内容：进行中时优先 activeForm（更动态），否则 content -->
      <span
        :class="[
          todo.status === 'completed'
            ? 'line-through text-muted-foreground'
            : todo.status === 'in_progress'
              ? 'text-foreground font-medium'
              : 'text-foreground/90',
        ]"
      >
        {{ todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content }}
      </span>
    </li>
  </ul>
</template>

<script setup lang="ts">
import type { ToolControlInfo } from '@shared/backend/types'
import { CheckIcon, CircleIcon } from 'lucide-vue-next'

defineProps<{ control: ToolControlInfo }>()
</script>
