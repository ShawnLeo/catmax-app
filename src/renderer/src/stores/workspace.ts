import type { WorkspaceRecord } from '@shared/domain'
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useWorkspaceStore = defineStore('workspace', () => {
  const workspaces = ref<WorkspaceRecord[]>([])
  const currentWorkspaceId = ref<string | null>(null)
  const loading = ref(false)

  const currentWorkspace = computed(() =>
    workspaces.value.find((w) => w.id === currentWorkspaceId.value),
  )

  async function load(): Promise<void> {
    loading.value = true
    try {
      workspaces.value = await window.api.workspace.list()
    } finally {
      loading.value = false
    }
  }

  async function add(path: string, name?: string): Promise<WorkspaceRecord> {
    const args = name === undefined ? { path } : { path, name }
    const ws = await window.api.workspace.add(args)
    workspaces.value.unshift(ws)
    return ws
  }

  async function remove(id: string): Promise<void> {
    await window.api.workspace.remove({ id })
    workspaces.value = workspaces.value.filter((w) => w.id !== id)
    if (currentWorkspaceId.value === id) {
      currentWorkspaceId.value = null
    }
  }

  async function rename(id: string, name: string): Promise<void> {
    await window.api.workspace.rename({ id, name })
    const ws = workspaces.value.find((w) => w.id === id)
    if (ws) ws.name = name
  }

  function setCurrent(id: string): void {
    currentWorkspaceId.value = id
  }

  return {
    workspaces,
    currentWorkspaceId,
    loading,
    currentWorkspace,
    load,
    add,
    remove,
    rename,
    setCurrent,
  }
})
