<template>
  <div
    :class="[
      'group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer',
      active ? 'bg-muted' : 'hover:bg-muted/50',
    ]"
    @click="$emit('click')"
  >
    <!--
      会话状态指示器 + backend 图标（混排列表里用图标区分 codex / claude）。

      四态（按优先级）：
        1. running：旋转的 Loader2Icon（后台 turn 正在跑）
        2. unreadActivity：小蓝点（后台 turn 跑完了用户还没看）
           - 蓝色而非绿色：用户不知道任务成败，绿色暗示"成功"有误导
           - 用户切到该 session 时自动清掉（setCurrentSession 清 unreadActivity）
        3. 默认：显示 backend 图标（淡 muted 色，区分 codex/claude）
        4. 当前会话：也显示 backend 图标

      running 状态由 messageStore.sessionStates 跟踪——applyEvent 按 sessionId
      路由事件，所以后台 session 的 isRunning 也能正确更新。
      unreadActivity 在 turn_completed 且非当前 session 时置 true。
    -->
    <div class="w-4 h-4 flex-shrink-0 flex items-center justify-center">
      <Loader2Icon v-if="running" class="w-3.5 h-3.5 text-muted-foreground animate-spin" />
      <span
        v-else-if="unreadActivity && !active"
        class="block w-2 h-2 rounded-full bg-info"
        title="有新活动"
      />
      <BackendIcon
        v-else
        :backend="backend"
        :class="['w-3.5 h-3.5', active ? 'text-foreground' : 'text-muted-foreground']"
        :title="backend"
      />
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
      class="opacity-0 group-hover:opacity-100 p-1 hover:text-destructive cursor-pointer"
      @click.stop="$emit('remove')"
    >
      <Trash2Icon class="w-3 h-3" />
    </button>
  </div>
</template>

<script setup lang="ts">
import BackendIcon from '@renderer/components/icons/BackendIcon.vue'
import { formatRelativeTime } from '@renderer/lib/format'
import type { BackendId } from '@shared/constants'
import type { SessionView } from '@shared/domain'
import { Loader2Icon, Trash2Icon } from 'lucide-vue-next'

defineProps<{
  session: SessionView
  active: boolean
  /** 会话所属 backend——显示对应品牌图标区分 codex/claude */
  backend: BackendId
  /** 该会话是否有 turn 在后台跑（messageStore.sessionStates 跟踪） */
  running?: boolean
  /** 后台 turn 完成但用户还没查看（显示小蓝点提示） */
  unreadActivity?: boolean
}>()
defineEmits<{ click: []; remove: [] }>()
</script>
