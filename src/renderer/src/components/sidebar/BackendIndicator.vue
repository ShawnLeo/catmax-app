<template>
  <div class="p-2 border-t border-sidebar-border">
    <div class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted">
      <div
        :class="[
          'w-2 h-2 rounded-full',
          backendStore.isAvailable ? 'bg-success' : 'bg-destructive',
        ]"
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
        >
          {{ status.id }}{{ status.available ? ` (${status.version})` : ' (unavailable)' }}
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
  </div>
</template>

<script setup lang="ts">
import { useBackendStore } from '@renderer/stores/backend'
import type { BackendId } from '@shared/constants'
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
</script>
