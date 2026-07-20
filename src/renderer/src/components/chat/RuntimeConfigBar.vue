<template>
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
          status.available
            ? status.version ?? undefined
            : explainBackendError(status.error).title
        "
      >
        {{ status.id
        }}{{ status.available ? '' : ` (${explainBackendError(status.error).title})` }}
      </option>
    </select>

    <!-- Model -->
    <select
      :value="modelValue.model"
      class="bg-secondary text-secondary-foreground text-xs px-2 py-1 rounded border-0 focus:outline-none"
      @change="onModelChange"
    >
      <option :value="null">(default)</option>
      <option v-for="m in backendStore.models" :key="m.id" :value="m.id">
        {{ m.displayName }}
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

    <!-- Effort -->
    <select
      :value="modelValue.effort"
      class="bg-secondary text-secondary-foreground text-xs px-2 py-1 rounded border-0 focus:outline-none"
      @change="onEffortChange"
    >
      <option :value="null">(default)</option>
      <option v-for="e in supportedEfforts" :key="e" :value="e">
        {{ e }}
      </option>
    </select>

    <!-- Permission Mode -->
    <select
      v-model="permissionMode"
      class="bg-secondary text-secondary-foreground text-xs px-2 py-1 rounded border-0 focus:outline-none"
    >
      <option v-for="m in supportedPermissionModes" :key="m" :value="m">
        {{ permissionLabel(m) }}
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
import type { EffortLevel, PermissionMode } from '@shared/backend/types'
import type { BackendId } from '@shared/constants'
import { RefreshCwIcon } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'

interface RuntimeConfigValue {
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode
}

const props = defineProps<{
  modelValue: RuntimeConfigValue
}>()
const emit = defineEmits<{ 'update:modelValue': [value: RuntimeConfigValue] }>()

const backendStore = useBackendStore()

const backendId = computed<BackendId>({
  get: () => backendStore.currentId,
  set: (v) => {
    void backendStore.switchTo(v)
  },
})

const permissionMode = computed<PermissionMode>({
  get: () => props.modelValue.permissionMode,
  set: (v) => {
    emit('update:modelValue', { ...props.modelValue, permissionMode: v })
  },
})

const supportedEfforts = computed<EffortLevel[]>(() => {
  return backendStore.current?.capabilities.supportedEfforts ?? ['low', 'medium', 'high']
})

const supportedPermissionModes = computed<PermissionMode[]>(() => {
  return (
    backendStore.current?.capabilities.supportedPermissionModes ?? [
      'default',
      'acceptEdits',
      'auto',
      'plan',
      'dontAsk',
      'bypassPermissions',
    ]
  )
})

function permissionLabel(m: PermissionMode): string {
  return {
    default: '每次问',
    acceptEdits: '自动接受编辑',
    auto: '自动',
    plan: '计划模式',
    dontAsk: '不问',
    bypassPermissions: '完全跳过权限',
  }[m]
}

function onBackendChange(): void {
  // backendId 的 setter 已经触发 switchTo
}

function onModelChange(e: Event): void {
  const target = e.target as HTMLSelectElement
  const value = target.value === 'null' ? null : target.value
  emit('update:modelValue', { ...props.modelValue, model: value })
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

function onEffortChange(e: Event): void {
  const target = e.target as HTMLSelectElement
  const value = (target.value === 'null' ? null : target.value) as EffortLevel | null
  emit('update:modelValue', { ...props.modelValue, effort: value })
}
</script>
