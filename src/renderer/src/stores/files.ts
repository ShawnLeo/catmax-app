import type { DirEntry, FilePreview } from '@shared/ipc/fs'
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useFilesStore = defineStore('files', () => {
  /** 当前展开的目录的 entries，key 是相对路径 */
  const directoryCache = ref<Map<string, DirEntry[]>>(new Map())
  /** 当前预览的文件 */
  const currentPreview = ref<FilePreview | null>(null)
  const loading = ref(false)

  async function openDirectory(workspacePath: string, relativePath = ''): Promise<DirEntry[]> {
    const entries = await window.api.fs.readDirectory({
      workspacePath,
      relativePath,
    })
    directoryCache.value.set(relativePath, entries)
    // 触发响应式
    directoryCache.value = new Map(directoryCache.value)
    return entries
  }

  async function previewFile(workspacePath: string, relativePath: string): Promise<void> {
    loading.value = true
    try {
      currentPreview.value = await window.api.fs.readFilePreview({
        workspacePath,
        relativePath,
      })
    } finally {
      loading.value = false
    }
  }

  async function openInEditor(
    workspaceId: string,
    relativePath: string,
    line?: number,
  ): Promise<{ launched: boolean; error?: string }> {
    const result = await window.api.fs.openInEditor({
      workspaceId,
      relativePath,
      ...(line !== undefined && { line }),
    })
    return {
      launched: result.launched,
      ...(result.error !== undefined && { error: result.error }),
    }
  }

  function reset(): void {
    directoryCache.value = new Map()
    currentPreview.value = null
  }

  return {
    directoryCache,
    currentPreview,
    loading,
    openDirectory,
    previewFile,
    openInEditor,
    reset,
  }
})
