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

  async function add(
    path: string,
    name?: string,
    secondaryPaths?: string[],
  ): Promise<WorkspaceRecord> {
    const args = {
      path,
      ...(name !== undefined && { name }),
      ...(secondaryPaths !== undefined && { secondaryPaths }),
    }
    const ws = await window.api.workspace.add(args)
    workspaces.value.unshift(ws)
    // 添加完自动切到新工作区——用户显式添加的意图就是想用它。
    // 之前每个调用点都得自己 setCurrent，容易漏（侧边栏/设置页/命令面板都漏过）。
    currentWorkspaceId.value = ws.id
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

  // 切换当前工作区，并把 last_opened_at 更新到后端，让"最近工作区"列表反映真实打开顺序。
  // 失败不抛——这只是辅助排序，不应阻塞打开流程。
  async function setCurrent(id: string): Promise<void> {
    currentWorkspaceId.value = id
    const idx = workspaces.value.findIndex((w) => w.id === id)
    if (idx === -1) return
    // 本地立即重排：更新时间戳并提到最前，UI 不必等下一次 load。
    const now = Date.now()
    workspaces.value[idx] = { ...workspaces.value[idx]!, lastOpenedAt: now }
    const [ws] = workspaces.value.splice(idx, 1)
    workspaces.value.unshift(ws!)
    try {
      await window.api.workspace.touch({ id })
    } catch {
      // 静默——touch 仅用于排序，失败不影响打开。
    }
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
