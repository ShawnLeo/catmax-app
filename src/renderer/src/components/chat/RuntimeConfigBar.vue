<template>
  <!--
    顶部配置条--只保留 backend 切换 + 连接状态。
    Model / Effort / PermissionMode 已下沉到 Composer 底部（跟发送按钮平齐）。
    刷新模型列表按钮也已随 Model 下沉到 Composer。
  -->
  <div class="border-b border-border px-4 py-2 flex items-center gap-2 bg-background">
    <!-- Backend -->
    <select
      v-model="backendId"
      class="bg-secondary text-secondary-foreground text-xs px-2 py-1 rounded border-0 focus:outline-none"
      :title="
        backendStore.current && !backendStore.current.available
          ? explainBackendError(backendStore.current.error).title +
            '：' +
            explainBackendError(backendStore.current.error).detail
          : undefined
      "
      @change="onBackendChange"
    >
      <option
        v-for="status in backendStore.statuses"
        :key="status.id"
        :value="status.id"
        :disabled="!status.available"
        :title="
          status.available ? (status.version ?? undefined) : explainBackendError(status.error).title
        "
      >
        {{ status.id }}{{ status.available ? '' : ` (${explainBackendError(status.error).title})` }}
      </option>
    </select>

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

function onBackendChange(): void {
  // backendId 的 setter 已经触发 switchTo
}
</script>
