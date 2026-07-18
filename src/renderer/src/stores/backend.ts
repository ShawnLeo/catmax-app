import type { BackendStatus, ModelOption } from '@shared/backend/types'
import type { BackendId } from '@shared/constants'
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useBackendStore = defineStore('backend', () => {
  const statuses = ref<BackendStatus[]>([])
  const currentId = ref<BackendId>('codex')
  const models = ref<ModelOption[]>([])
  const loading = ref(false)

  const current = computed(() => statuses.value.find((s) => s.id === currentId.value) ?? null)
  const isAvailable = computed(() => current.value?.available ?? false)

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      statuses.value = await window.api.backend.list()
      const c = await window.api.backend.current()
      currentId.value = c.id
    } finally {
      loading.value = false
    }
  }

  async function switchTo(id: BackendId): Promise<void> {
    await window.api.backend.switch({ id })
    currentId.value = id
    // 重新加载模型
    await loadModels()
  }

  async function loadModels(): Promise<void> {
    models.value = await window.api.backend.listModels()
  }

  return {
    statuses,
    currentId,
    models,
    loading,
    current,
    isAvailable,
    refresh,
    switchTo,
    loadModels,
  }
})
