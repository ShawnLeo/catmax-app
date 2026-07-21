import type { EffortLevel, PermissionMode } from '@shared/backend/types'
import { BACKEND_IDS, type BackendId } from '@shared/constants'
import type { SessionView } from '@shared/domain'
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useSessionStore = defineStore('session', () => {
  const sessions = ref<SessionView[]>([])
  const currentSessionId = ref<string | null>(null)
  const loading = ref(false)

  const currentSession = computed(() => sessions.value.find((s) => s.id === currentSessionId.value))

  /**
   * 按 backend id 分组——给侧边栏 tab 用。
   *
   * 之前用 continuable/readonly 二分有个问题：continuable 是 main 端 fetch 时
   * 根据"当时的 currentBackend"算出来的，切 backend 后不会自动重算（除非重新 load）。
   * 直接按 session.backend 字段分组就没这个问题——backend 是会话固有属性，
   * 不依赖当前 backend。
   */
  const sessionsByBackend = computed(() => {
    const byId = {} as Record<BackendId, SessionView[]>
    for (const id of BACKEND_IDS) byId[id] = []
    for (const s of sessions.value) {
      const bucket = byId[s.backend]
      if (bucket) bucket.push(s)
    }
    return byId
  })

  /** 每个 backend 的会话数——给 tab badge 用 */
  const countByBackend = computed(() => {
    const counts = {} as Record<BackendId, number>
    for (const id of BACKEND_IDS) counts[id] = sessionsByBackend.value[id].length
    return counts
  })

  async function load(workspaceId: string): Promise<void> {
    loading.value = true
    try {
      sessions.value = await window.api.session.list({ workspaceId })
    } finally {
      loading.value = false
    }
  }

  /** 与后端对账（启动时、切工作区时、切后端时调） */
  async function reconcile(workspaceId: string): Promise<void> {
    const { added, removed } = await window.api.session.reconcile({ workspaceId })
    if (added.length > 0 || removed.length > 0) {
      await load(workspaceId)
    }
  }

  async function create(args: {
    workspaceId: string
    cwd: string
    backend?: BackendId
    model?: string
    effort?: EffortLevel
    permissionMode?: PermissionMode
    initialPrompt?: string
  }): Promise<string> {
    const { sessionId } = await window.api.session.create(args)
    await load(args.workspaceId)
    return sessionId
  }

  async function remove(sessionId: string): Promise<void> {
    await window.api.session.remove({ sessionId })
    sessions.value = sessions.value.filter((s) => s.id !== sessionId)
    if (currentSessionId.value === sessionId) {
      currentSessionId.value = null
    }
  }

  function setCurrent(sessionId: string): void {
    currentSessionId.value = sessionId
  }

  async function loadHistory(sessionId: string): Promise<void> {
    const { useMessageStore } = await import('@renderer/stores/message')
    const messageStore = useMessageStore()
    messageStore.setLoading(true)
    try {
      const detail = await window.api.session.detail({ sessionId })
      messageStore.setMessages(detail.messages)

      // 后端给了 aiTitle 且 db 里之前没有标题时，main handler 已经回写 db。
      // 这里同步更新本地 sessions 数组里的 title，让侧边栏立即显示新标题。
      if (detail.aiTitle) {
        const target = sessions.value.find((s) => s.id === sessionId)
        if (target && target.title !== detail.aiTitle) {
          target.title = detail.aiTitle
        }
      }
    } catch (e) {
      messageStore.setError(e instanceof Error ? e.message : String(e))
    } finally {
      messageStore.setLoading(false)
    }
  }

  return {
    sessions,
    currentSessionId,
    loading,
    currentSession,
    sessionsByBackend,
    countByBackend,
    load,
    reconcile,
    create,
    remove,
    setCurrent,
    loadHistory,
  }
})
