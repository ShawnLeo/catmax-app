<template>
  <div
    :class="[
      'group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer',
      active ? 'bg-muted' : 'hover:bg-muted/50',
    ]"
    @click="$emit('click')"
  >
    <!--
      会话状态指示器（替换原来的 MessageSquareIcon 固定图标）：

      三态：
        - running：旋转的 Loader2Icon（后台 turn 正在跑）
        - 已结束 + 非当前会话：小绿点（标识"有活动可看"）
        - 已结束 + 当前会话（active）：不显示（不重复标识自己）

      running 状态由 messageStore.sessionStates 跟踪——applyEvent 按 sessionId
      路由事件，所以后台 session 的 isRunning 也能正确更新。
    -->
    <div class="w-4 h-4 flex-shrink-0 flex items-center justify-center">
      <Loader2Icon v-if="running" class="w-3.5 h-3.5 text-muted-foreground animate-spin" />
      <span
        v-else-if="!active"
        class="block w-1.5 h-1.5 rounded-full bg-success"
        title="会话已结束"
      />
      <!-- active + 不 running：不显示任何指示器 -->
    </div>

    <div class="flex-1 min-w-0">
      <div class="text-sm text-foreground truncate">
        {{ session.title || '(新会话)' }}
      </div>
      <div class="text-xs text-muted-foreground">
        {{ formatRelativeTime(session.lastActiveAt) }}
      </div>
    </div>

    <!-- 删除按钮（hover 显示） -->
    <button
      class="opacity-0 group-hover:opacity-100 p-1 hover:text-destructive"
      @click.stop="$emit('remove')"
    >
      <Trash2Icon class="w-3 h-3" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { formatRelativeTime } from '@renderer/lib/format'
import type { SessionView } from '@shared/domain'
import { Loader2Icon, Trash2Icon } from 'lucide-vue-next'

defineProps<{
  session: SessionView
  active: boolean
  /** 该会话是否有 turn 在后台跑（messageStore.sessionStates 跟踪） */
  running?: boolean
}>()
defineEmits<{ click: []; remove: [] }>()
</script>
