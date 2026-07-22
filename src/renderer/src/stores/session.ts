import type { EffortLevel, PermissionMode } from '@shared/backend/types'
import { type BackendId } from '@shared/constants'
import type { SessionView } from '@shared/domain'
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useSessionStore = defineStore('session', () => {
  const sessions = ref<SessionView[]>([])
  const currentSessionId = ref<string | null>(null)
  const loading = ref(false)

  const currentSession = computed(() => sessions.value.find((s) => s.id === currentSessionId.value))

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
    load,
    reconcile,
    create,
    remove,
    setCurrent,
    loadHistory,
  }
})
