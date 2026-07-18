import type { PermissionMode } from '@shared/backend/types'
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

  async function create(args: {
    workspaceId: string
    cwd: string
    model?: string
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    permissionMode?: PermissionMode
    initialPrompt?: string
  }): Promise<string> {
    const { sessionId } = await window.api.session.create(args)
    // 重新加载列表（简化：让 UI 立即看到新会话）
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

  return {
    sessions,
    currentSessionId,
    loading,
    currentSession,
    load,
    create,
    remove,
    setCurrent,
  }
})
