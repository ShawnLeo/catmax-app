<template>
  <div class="p-2 border-t border-sidebar-border">
    <div class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted">
      <div
        :class="[
          'w-2 h-2 rounded-full',
          backendStore.isAvailable ? 'bg-success' : 'bg-destructive',
        ]"
        :title="backendStore.current ? formatError(backendStore.current.error) : undefined"
      />
      <select
        v-model="backendId"
        class="flex-1 bg-transparent text-sm text-foreground border-0 focus:outline-none cursor-pointer"
      >
        <option
          v-for="status in backendStore.statuses"
          :key="status.id"
          :value="status.id"
          :disabled="!status.available"
          :title="
            status.available
              ? `${status.version ?? ''}`
              : formatError(status.error)
          "
        >
          {{ status.id
          }}{{ status.available ? ` (${status.version})` : ` (${shortError(status.error)})` }}
        </option>
      </select>
      <button
        class="text-muted-foreground hover:text-foreground"
        title="设置"
        @click="openSettings"
      >
        <SettingsIcon class="w-4 h-4" />
      </button>
    </div>

    <!-- 当前 backend 不可用时，显示一行错误简述 + 修复指引（点击展开） -->
    <details v-if="backendStore.current && !backendStore.current.available" class="mt-1 px-2">
      <summary class="text-xs text-destructive cursor-pointer hover:underline">
        {{ explainBackendError(backendStore.current.error).title }} · 点击查看修复指引
      </summary>
      <div class="mt-2 p-2 rounded bg-destructive/5 text-xs text-muted-foreground space-y-1">
        <p class="text-foreground font-medium">
          {{ explainBackendError(backendStore.current.error).title }}
        </p>
        <p>{{ explainBackendError(backendStore.current.error).detail }}</p>
        <ol v-if="explainBackendError(backendStore.current.error).fix" class="list-decimal ml-4 space-y-0.5">
          <li v-for="(step, i) in explainBackendError(backendStore.current.error).fix" :key="i">
            {{ step }}
          </li>
        </ol>
      </div>
    </details>
  </div>
</template>

<script setup lang="ts">
import { useBackendStore } from '@renderer/stores/backend'
import type { BackendId } from '@shared/constants'
import { explainBackendError } from '@renderer/lib/backend-error'
import { SettingsIcon } from 'lucide-vue-next'
import { computed } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const backendStore = useBackendStore()

const backendId = computed<BackendId>({
  get: () => backendStore.currentId,
  set: (v) => {
    void backendStore.switchTo(v)
  },
})

function openSettings(): void {
  router.push('/settings')
}

/** 下拉框里用的短错误描述 */
function shortError(code: string | null | undefined): string {
  if (!code) return 'unavailable'
  return explainBackendError(code).title
}

/** HTML title 属性用的多行错误描述 */
function formatError(code: string | null | undefined): string {
  const info = explainBackendError(code)
  let text = `${info.title}\n${info.detail}`
  if (info.fix) {
    text += '\n\n修复步骤：\n' + info.fix.map((s) => `  · ${s}`).join('\n')
  }
  return text
}
</script>
