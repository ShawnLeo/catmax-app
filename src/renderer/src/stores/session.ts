import type { EffortLevel, PermissionMode } from '@shared/backend/types'
import type { BackendId } from '@shared/constants'
import type { SessionView } from '@shared/domain'
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useSessionStore = defineStore('session', () => {
  const sessions = ref<SessionView[]>([])
  const currentSessionId = ref<string | null>(null)
  const loading = ref(false)

  const currentSession = computed(() => sessions.value.find((s) => s.id === currentSessionId.value))

  /** 按 backend 分组（当前后端 = continuable，其他 = readonly） */
  const sessionsByBackend = computed(() => {
    const continuable: SessionView[] = []
    const readonly: SessionView[] = []
    for (const s of sessions.value) {
      if (s.continuable) continuable.push(s)
      else readonly.push(s)
    }
    return { continuable, readonly }
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

  return {
    sessions,
    currentSessionId,
    loading,
    currentSession,
    sessionsByBackend,
    load,
    reconcile,
    create,
    remove,
    setCurrent,
  }
})
