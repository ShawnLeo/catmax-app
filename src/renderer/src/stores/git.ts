import type { GitStatus } from '@shared/ipc/git'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

const EMPTY_STATUS: GitStatus = {
  isRepo: false,
  branch: null,
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  untracked: [],
  recentCommits: [],
}

export const useGitStore = defineStore('git', () => {
  const status = ref<GitStatus>(EMPTY_STATUS)
  const loading = ref(false)
  const lastError = ref<string | null>(null)

  const totalChanges = computed(
    () => status.value.staged.length + status.value.unstaged.length + status.value.untracked.length,
  )

  async function refresh(workspacePath: string): Promise<void> {
    loading.value = true
    lastError.value = null
    try {
      status.value = await window.api.git.status({ workspacePath })
    } catch (e) {
      lastError.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  function reset(): void {
    status.value = EMPTY_STATUS
    lastError.value = null
  }

  return { status, loading, lastError, totalChanges, refresh, reset }
})
