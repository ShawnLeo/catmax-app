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

  /**
   * 强制刷新模型列表——main 进程会先清掉缓存的 cachedModelsPromise 再重新拉。
   * UI 上"刷新模型"按钮调它。场景：用户在外部 codex login 换了账户、
   * codex 升级了版本，想立即看到新模型，不想等下次切 backend。
   */
  async function refreshModels(): Promise<void> {
    models.value = await window.api.backend.refreshModels()
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
    refreshModels,
  }
})
