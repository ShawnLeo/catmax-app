<template>
  <!--
    顶部配置条——只保留 backend 切换 + 模型刷新 + 连接状态。
    Model / Effort / PermissionMode 已下沉到 Composer 底部（跟发送按钮平齐）。
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

    <!-- 刷新模型列表——清 main 端 cachedModelsPromise，重新拉一次 model/list -->
    <button
      type="button"
      class="text-secondary-foreground/60 hover:text-secondary-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      :disabled="refreshing"
      title="刷新模型列表"
      @click="onRefreshModels"
    >
      <RefreshCwIcon class="w-3 h-3" :class="refreshing ? 'animate-spin' : ''" />
    </button>

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
import { RefreshCwIcon } from 'lucide-vue-next'
import { computed, ref } from 'vue'

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

const refreshing = ref(false)
async function onRefreshModels(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await backendStore.refreshModels()
  } finally {
    refreshing.value = false
  }
}
</script>
