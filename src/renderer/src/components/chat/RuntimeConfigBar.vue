<template>
  <!--
    顶部配置条--只保留 backend 切换 + 连接状态。
    Model / Effort / PermissionMode 已下沉到 Composer 底部（跟发送按钮平齐）。
    刷新模型列表按钮也已随 Model 下沉到 Composer。
  -->
  <div class="border-b border-border px-4 py-2 flex items-center gap-2 bg-background">
    <!-- Backend -->
    <DropdownMenu
      v-model="backendId"
      :options="
        backendStore.statuses.map((s) => ({
          value: s.id,
          label: s.id + (s.available ? '' : ` (${explainBackendError(s.error).title})`),
          disabled: !s.available,
          title: s.available ? (s.version ?? undefined) : explainBackendError(s.error).title,
        }))
      "
      :title="
        backendStore.current && !backendStore.current.available
          ? explainBackendError(backendStore.current.error).title +
            '：' +
            explainBackendError(backendStore.current.error).detail
          : undefined
      "
    />

    <div class="flex-1" />

    <!-- Backend status -->
    <span
      :class="[
        'text-xs px-2 py-0.5 rounded-full',
        backendStore.isAvailable
          ? 'bg-success/10 text-success'
          : 'bg-destructive/10 text-destructive',
      ]"
    >
      {{ backendStore.current?.version ?? 'not connected' }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { DropdownMenu } from '@renderer/components/ui/dropdown-menu'
import { explainBackendError } from '@renderer/lib/backend-error'
import { useBackendStore } from '@renderer/stores/backend'
import type { BackendId } from '@shared/constants'
import { computed } from 'vue'

const backendStore = useBackendStore()

const backendId = computed<BackendId>({
  get: () => backendStore.currentId,
  set: (v) => {
    void backendStore.switchTo(v)
  },
})
</script>
