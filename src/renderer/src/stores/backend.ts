import type { BackendStatus, ModelOption } from '@shared/backend/types'
import { BACKEND_IDS, type BackendId } from '@shared/constants'
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useBackendStore = defineStore('backend', () => {
  const statuses = ref<BackendStatus[]>([])
  const currentId = ref<BackendId>('codex')
  const models = ref<ModelOption[]>([])
  // 按 backend 分别缓存的模型列表——设置页同时展示两个 backend 的可选模型。
  // 进设置页时 loadAllBackendModels() 并行拉取；codex 首次会 spawn app-server。
  const modelsByBackend = ref<Record<BackendId, ModelOption[]>>({ codex: [], claude: [] })
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

  /**
   * 拉指定 backend 的模型列表（不切换当前 backend）。
   * codex 不可用 / spawn 失败时静默置空，UI 显示提示。
   */
  async function loadModelsFor(id: BackendId): Promise<void> {
    try {
      modelsByBackend.value[id] = await window.api.backend.listModelsFor({ id })
    } catch (e) {
      console.warn(`[backend] loadModelsFor(${id}) failed:`, e)
      modelsByBackend.value[id] = []
    }
  }

  /** 并行拉所有 backend 的模型列表（设置页进页时调） */
  async function loadAllBackendModels(): Promise<void> {
    const ids =
      statuses.value.length > 0 ? statuses.value.map((status) => status.id) : [...BACKEND_IDS]
    await Promise.all(ids.map((id) => loadModelsFor(id)))
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
    modelsByBackend,
    loading,
    current,
    isAvailable,
    refresh,
    switchTo,
    loadModels,
    loadModelsFor,
    loadAllBackendModels,
    refreshModels,
  }
})
