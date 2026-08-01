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
        <span class="text-[length:var(--ui-text-base)] font-medium text-foreground truncate flex-1">
          {{ session.title ?? '(无标题)' }}
        </span>
        <span
          v-if="session.alreadyImported"
          class="text-[length:var(--ui-text-d5)] text-muted-foreground flex-shrink-0"
        >
          已导入
        </span>
      </div>
      <div class="text-[length:var(--ui-text-d3)] text-muted-foreground truncate mt-0.5 font-mono">
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

    <!-- workspace 选择器（amber 警告边框靠外层 wrapper 表达） -->
    <div
      class="flex-shrink-0 rounded"
      :class="{ 'border border-amber-500/50': !selectedWorkspaceId && session.cwd }"
    >
      <DropdownMenu
        :model-value="selectedWorkspaceId"
        :options="
          workspaces.map((ws) => ({
            value: ws.id,
            label: ws.name,
          }))
        "
        :placeholder="'选择工作区...'"
        align="right"
        @update:model-value="(v) => v && emit('selectWorkspace', v)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { DropdownMenu } from '@renderer/components/ui/dropdown-menu'
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
