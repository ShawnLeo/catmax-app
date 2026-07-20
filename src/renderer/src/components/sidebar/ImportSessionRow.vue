<template>
  <!--
    单条 importable session 行：复选框 + 标题/元信息 + workspace 下拉。
    父组件通过 v-model:checked 和 v-model:workspaceId 双向绑定。
  -->
  <div class="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/50 transition-colors">
    <!-- 复选框 -->
    <input
      type="checkbox"
      :checked="checked"
      class="cursor-pointer flex-shrink-0"
      @change="$emit('toggle')"
    />

    <!-- 主信息 -->
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2">
        <span
          :class="[
            'text-[10px] px-1.5 py-0.5 rounded uppercase font-medium flex-shrink-0',
            session.backend === 'codex'
              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
              : 'bg-orange-500/15 text-orange-700 dark:text-orange-400',
          ]"
        >
          {{ session.backend }}
        </span>
        <span class="text-sm font-medium text-foreground truncate flex-1">
          {{ session.title ?? '(无标题)' }}
        </span>
        <span
          v-if="session.alreadyImported"
          class="text-[10px] text-muted-foreground flex-shrink-0"
        >
          已导入
        </span>
      </div>
      <div class="text-xs text-muted-foreground truncate mt-0.5 font-mono">
        <!-- claude 显示 cwd（反推路径）；codex 显示 thread id -->
        <span v-if="session.cwd" :title="session.cwd">{{ session.cwd }}</span>
        <span v-else :title="session.backendThreadId">{{ shortThreadId }}</span>
        <span class="mx-1.5 opacity-50">·</span>
        <span>{{ formatRelativeTime(session.lastActiveAt) }}</span>
        <template v-if="session.sizeBytes !== undefined">
          <span class="mx-1.5 opacity-50">·</span>
          <span>{{ formatSize(session.sizeBytes) }}</span>
        </template>
      </div>
      <!-- 父组件传入的提示插槽（如"新建工作区"快捷入口） -->
      <div v-if="$slots.hint" class="mt-1">
        <slot name="hint" />
      </div>
    </div>

    <!-- workspace 选择器 -->
    <select
      :value="selectedWorkspaceId ?? ''"
      class="text-xs border border-border rounded px-2 py-1 bg-background max-w-[200px] flex-shrink-0"
      :class="{ 'border-amber-500/50': !selectedWorkspaceId && session.cwd }"
      @change="onSelectChange(($event.target as HTMLSelectElement).value)"
    >
      <option value="" disabled>选择工作区...</option>
      <option v-for="ws in workspaces" :key="ws.id" :value="ws.id">
        {{ ws.name }}
      </option>
    </select>
  </div>
</template>

<script setup lang="ts">
import type { WorkspaceRecord } from '@shared/domain'
import type { ImportableSession } from '@shared/ipc/session'
import { computed } from 'vue'

const props = defineProps<{
  session: ImportableSession
  workspaces: WorkspaceRecord[]
  selectedWorkspaceId: string | null
  checked: boolean
}>()

const emit = defineEmits<{
  toggle: []
  selectWorkspace: [wsId: string]
}>()

const shortThreadId = computed(() => props.session.backendThreadId.slice(0, 8))

function onSelectChange(v: string): void {
  if (v) emit('selectWorkspace', v)
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
</script>
