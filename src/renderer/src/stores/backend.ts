import type { BackendInstallProgress, BackendInstallResult } from '@shared/backend/install'
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

  // ============ Backend Install ============

  /** 按 backend 记的安装进度。null = 从没装过 / 已经消掉。 */
  const installProgress = ref<Record<BackendId, BackendInstallProgress | null>>({})
  let unsubscribeInstall: (() => void) | null = null

  /**
   * 订阅安装进度推送。幂等——设置页每次挂载都会调，重复调不会叠加订阅。
   * 不放在 store 顶层是因为 store 可能在 window.api 就绪前被创建。
   */
  function ensureInstallSubscription(): void {
    if (unsubscribeInstall) return
    unsubscribeInstall = window.api.backend.onInstallProgress((progress) => {
      installProgress.value = { ...installProgress.value, [progress.backendId]: progress }
    })
  }

  function isInstalling(id: BackendId): boolean {
    const phase = installProgress.value[id]?.phase
    return phase !== undefined && !['done', 'error', 'cancelled'].includes(phase)
  }

  /**
   * 一键安装某个 backend。主进程负责下载/校验/解压并写回 settings，
   * 这里只负责先建好订阅（否则会漏掉最早的几个进度事件）、装完刷状态。
   */
  async function install(id: BackendId): Promise<BackendInstallResult> {
    ensureInstallSubscription()
    // 乐观置一个 resolving，让按钮立刻进入"安装中"，不用等第一个推送
    installProgress.value = {
      ...installProgress.value,
      [id]: {
        backendId: id,
        phase: 'resolving',
        receivedBytes: 0,
        totalBytes: null,
        version: null,
        error: null,
      },
    }
    const result = await window.api.backend.install({ id })
    // 主进程的守卫分支（比如"已有安装在进行中"）直接返回，不会推终态进度事件——
    // 不按返回值兜底的话卡片会永远停在"安装中"。
    if (isInstalling(id)) {
      installProgress.value = {
        ...installProgress.value,
        [id]: {
          backendId: id,
          phase: result.cancelled ? 'cancelled' : result.ok ? 'done' : 'error',
          receivedBytes: 0,
          totalBytes: null,
          version: result.version ?? null,
          error: result.error ?? null,
        },
      }
    }
    // 装成功后 statuses 里的 available/error 变了，重拉一次让 UI 收起安装卡片
    await refresh()
    return result
  }

  async function cancelInstall(id: BackendId): Promise<void> {
    await window.api.backend.cancelInstall({ id })
  }

  /** 关掉安装卡片上残留的成功/失败提示 */
  function clearInstallProgress(id: BackendId): void {
    installProgress.value = { ...installProgress.value, [id]: null }
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
    installProgress,
    ensureInstallSubscription,
    isInstalling,
    install,
    cancelInstall,
    clearInstallProgress,
  }
})
