<template>
  <div
    :class="[
      'group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer',
      active ? 'bg-muted' : 'hover:bg-muted/50',
    ]"
    @click="$emit('click')"
  >
    <MessageSquareIcon class="w-4 h-4 flex-shrink-0 text-muted-foreground" />
    <div class="flex-1 min-w-0">
      <div class="text-sm text-foreground truncate">
        {{ session.title || '(新会话)' }}
      </div>
      <div class="text-xs text-muted-foreground flex items-center gap-1">
        <span>{{ session.backend }}</span>
        <span>·</span>
        <span>{{ formatRelativeTime(session.lastActiveAt) }}</span>
      </div>
    </div>

    <!-- 只读标记 -->
    <LockIcon v-if="readonly" class="w-3 h-3 text-muted-foreground flex-shrink-0" />

    <!-- 删除按钮（hover 显示，只读也允许删） -->
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
import { MessageSquareIcon, Trash2Icon, LockIcon } from 'lucide-vue-next'

defineProps<{
  session: SessionView
  active: boolean
  readonly?: boolean
}>()
defineEmits<{ click: []; remove: [] }>()
</script>
