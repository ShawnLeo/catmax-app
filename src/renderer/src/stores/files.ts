import { useUiStore } from '@renderer/stores/ui'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type { DirEntry, FilePreview } from '@shared/ipc/fs'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export interface FilePreviewTab {
  relativePath: string
  preview: FilePreview | null
  loading: boolean
  error: string | null
}

export const useFilesStore = defineStore('files', () => {
  // File Tree Data: 目录按路径懒加载并缓存，展开、加载和错误状态彼此独立。
  const directoryCache = ref<Map<string, DirEntry[]>>(new Map())
  const expandedPaths = ref<Set<string>>(new Set())
  const loadingPaths = ref<Set<string>>(new Set())
  const directoryErrors = ref<Map<string, string>>(new Map())

  // File Preview Tabs: 每个路径只对应一个 tab，activePreviewPath 决定当前预览。
  const previewTabs = ref<FilePreviewTab[]>([])
  const activePreviewPath = ref<string | null>(null)

  // File Tree Search: 搜索状态独立于树缓存，清空查询即可无损返回原树。
  const searchQuery = ref('')
  const searchResults = ref<DirEntry[]>([])
  const searchLoading = ref(false)
  const requiresRestart = ref(
    typeof window.api.fs.searchFiles !== 'function' ||
      typeof window.api.fs.resolveFileReference !== 'function',
  )

  const activePreviewTab = computed(
    () => previewTabs.value.find((tab) => tab.relativePath === activePreviewPath.value) ?? null,
  )
  const currentPreview = computed(() => activePreviewTab.value?.preview ?? null)
  const previewLoading = computed(() => activePreviewTab.value?.loading ?? false)
  const previewError = computed(() => activePreviewTab.value?.error ?? null)
  const hasPreview = computed(() => previewTabs.value.length > 0)

  async function openDirectory(
    workspaceId: string,
    relativePath = '',
    force = false,
  ): Promise<DirEntry[]> {
    if (!force) {
      const cached = directoryCache.value.get(relativePath)
      if (cached) return cached
    }

    setInSet(loadingPaths, relativePath, true)
    setInMap(directoryErrors, relativePath, undefined)
    try {
      const entries = await window.api.fs.readDirectory({
        workspaceId,
        ...workspacePathArgument(workspaceId),
        relativePath,
      })
      setInMap(directoryCache, relativePath, entries)
      return entries
    } catch (error) {
      setInMap(directoryErrors, relativePath, errorMessage(error))
      return []
    } finally {
      setInSet(loadingPaths, relativePath, false)
    }
  }

  async function toggleDirectory(workspaceId: string, entry: DirEntry): Promise<void> {
    if (!entry.isDirectory || entry.isSymlink) return
    if (expandedPaths.value.has(entry.relativePath)) {
      setInSet(expandedPaths, entry.relativePath, false)
      return
    }
    setInSet(expandedPaths, entry.relativePath, true)
    await openDirectory(workspaceId, entry.relativePath)
  }

  async function previewFile(
    workspaceId: string,
    relativePath: string,
    force = false,
  ): Promise<FilePreview | null> {
    const tab = ensurePreviewTab(relativePath)
    activePreviewPath.value = relativePath
    if (tab.preview && !force) return tab.preview

    tab.loading = true
    tab.error = null
    try {
      const rawPreview = await window.api.fs.readFilePreview({
        workspaceId,
        ...workspacePathArgument(workspaceId),
        relativePath,
      })
      tab.preview = normalizePreview(rawPreview, relativePath, directoryCache.value)
      return tab.preview
    } catch (error) {
      tab.error = errorMessage(error)
      return null
    } finally {
      tab.loading = false
    }
  }

  async function openFile(workspaceId: string, relativePath: string): Promise<void> {
    useUiStore().showRightPanel('files')
    await previewFile(workspaceId, relativePath)
  }

  // Chat File Reference: 聊天区、工具调用和文件 pill 最终都汇聚到同一预览入口。
  async function openFileReference(workspaceId: string, reference: string): Promise<boolean> {
    const resolveReference = window.api.fs.resolveFileReference
    let resolved: { relativePath: string; line?: number; column?: number } | null = null
    if (typeof resolveReference === 'function') {
      try {
        resolved = await resolveReference({
          workspaceId,
          ...workspacePathArgument(workspaceId),
          reference,
        })
      } catch {
        requiresRestart.value = true
      }
    }
    // Dev Runtime Compatibility: main/preload 未重启时用 renderer 侧解析维持基本跳转能力。
    resolved ??= resolveLegacyFileReference(
      reference,
      workspacePathArgument(workspaceId).workspacePath,
    )
    if (!resolved) return false
    await openFile(workspaceId, resolved.relativePath)
    return true
  }

  async function search(workspaceId: string, query: string): Promise<void> {
    searchQuery.value = query
    if (!query.trim()) {
      searchResults.value = []
      searchLoading.value = false
      return
    }
    searchLoading.value = true
    try {
      const searchFiles = window.api.fs.searchFiles
      const results =
        typeof searchFiles === 'function'
          ? await searchFiles({
              workspaceId,
              ...workspacePathArgument(workspaceId),
              query,
              limit: 200,
            })
          : searchCachedEntries(directoryCache.value, query, 200)
      if (searchQuery.value === query) searchResults.value = results
    } catch {
      if (searchQuery.value === query) {
        requiresRestart.value = true
        searchResults.value = searchCachedEntries(directoryCache.value, query, 200)
      }
    } finally {
      if (searchQuery.value === query) searchLoading.value = false
    }
  }

  async function refresh(workspaceId: string): Promise<void> {
    const paths = ['', ...expandedPaths.value]
    await Promise.all(paths.map((path) => openDirectory(workspaceId, path, true)))
    if (currentPreview.value) {
      await previewFile(workspaceId, currentPreview.value.relativePath, true)
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

  function collapseAll(): void {
    expandedPaths.value = new Set()
  }

  function selectPreview(relativePath: string): void {
    if (previewTabs.value.some((tab) => tab.relativePath === relativePath)) {
      activePreviewPath.value = relativePath
    }
  }

  function closePreview(relativePath = activePreviewPath.value): void {
    if (!relativePath) return
    const index = previewTabs.value.findIndex((tab) => tab.relativePath === relativePath)
    if (index === -1) return
    const wasActive = activePreviewPath.value === relativePath
    previewTabs.value.splice(index, 1)
    if (wasActive) {
      // File Preview Tabs: 关闭活动 tab 后优先选择右邻项，再回退到左邻项。
      activePreviewPath.value =
        previewTabs.value[index]?.relativePath ?? previewTabs.value[index - 1]?.relativePath ?? null
    }
  }

  function closeAllPreviews(): void {
    previewTabs.value = []
    activePreviewPath.value = null
  }

  function reset(): void {
    directoryCache.value = new Map()
    expandedPaths.value = new Set()
    loadingPaths.value = new Set()
    directoryErrors.value = new Map()
    previewTabs.value = []
    activePreviewPath.value = null
    searchQuery.value = ''
    searchResults.value = []
  }

  function ensurePreviewTab(relativePath: string): FilePreviewTab {
    const existing = previewTabs.value.find((tab) => tab.relativePath === relativePath)
    if (existing) return existing
    const tab: FilePreviewTab = {
      relativePath,
      preview: null,
      loading: false,
      error: null,
    }
    previewTabs.value.push(tab)
    return previewTabs.value[previewTabs.value.length - 1]!
  }

  return {
    directoryCache,
    expandedPaths,
    loadingPaths,
    directoryErrors,
    previewTabs,
    activePreviewPath,
    activePreviewTab,
    currentPreview,
    previewLoading,
    previewError,
    searchQuery,
    searchResults,
    searchLoading,
    requiresRestart,
    hasPreview,
    openDirectory,
    toggleDirectory,
    previewFile,
    openFile,
    openFileReference,
    search,
    refresh,
    openInEditor,
    collapseAll,
    selectPreview,
    closePreview,
    closeAllPreviews,
    reset,
  }
})

function setInSet(target: { value: Set<string> }, key: string, present: boolean): void {
  const next = new Set(target.value)
  if (present) next.add(key)
  else next.delete(key)
  target.value = next
}

function setInMap<T>(target: { value: Map<string, T> }, key: string, value: T | undefined): void {
  const next = new Map(target.value)
  if (value === undefined) next.delete(key)
  else next.set(key, value)
  target.value = next
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function workspacePathArgument(workspaceId: string): { workspacePath?: string } {
  // Dev Runtime Compatibility: 仅供旧的热更新主进程使用，新主进程忽略这个非可信路径。
  const workspace = useWorkspaceStore().workspaces.find((item) => item.id === workspaceId)
  return workspace ? { workspacePath: workspace.path } : {}
}

function normalizePreview(
  raw: Partial<FilePreview>,
  relativePath: string,
  directoryCache: Map<string, DirEntry[]>,
): FilePreview {
  // Dev Runtime Compatibility: 补齐旧 preload 返回的精简预览结构，便于开发时无缝刷新。
  const cachedEntry = [...directoryCache.values()]
    .flat()
    .find((entry) => entry.relativePath === relativePath)
  const isBinary = raw.isBinary ?? raw.encoding === 'binary'
  return {
    relativePath: raw.relativePath ?? relativePath,
    absolutePath: raw.absolutePath ?? relativePath,
    name: raw.name ?? fileName(relativePath),
    size: raw.size ?? cachedEntry?.size ?? 0,
    mimeType: raw.mimeType ?? (isBinary ? 'application/octet-stream' : 'text/plain'),
    kind: raw.kind ?? legacyPreviewKind(relativePath, isBinary),
    isBinary,
    content: raw.content ?? null,
    dataUrl: raw.dataUrl ?? null,
    language: raw.language ?? null,
    truncated: raw.truncated ?? false,
    encoding: raw.encoding ?? (isBinary ? 'binary' : 'utf-8'),
    modifiedAt: raw.modifiedAt ?? cachedEntry?.modifiedAt ?? 0,
  }
}

function legacyPreviewKind(relativePath: string, isBinary: boolean): FilePreview['kind'] {
  if (isBinary) return 'binary'
  const extension = relativePath.split('.').pop()?.toLowerCase()
  if (extension === 'md' || extension === 'markdown' || extension === 'mdx') return 'markdown'
  if (extension === 'csv' || extension === 'tsv') return 'table'
  return 'text'
}

function searchCachedEntries(
  directoryCache: Map<string, DirEntry[]>,
  query: string,
  limit: number,
): DirEntry[] {
  // Dev Runtime Compatibility: 旧主进程无法递归搜索时，仅在已加载目录缓存内降级搜索。
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const entries = [...directoryCache.values()].flat()
  const uniqueEntries = new Map(entries.map((entry) => [entry.relativePath, entry]))
  return [...uniqueEntries.values()]
    .filter((entry) => entry.relativePath.toLocaleLowerCase().includes(normalizedQuery))
    .slice(0, limit)
}

function resolveLegacyFileReference(
  reference: string,
  workspacePath?: string,
): { relativePath: string; line?: number; column?: number } | null {
  // Dev Runtime Compatibility: 本地解析只接受安全相对路径，最终读取仍由主进程校验。
  let candidate = reference.trim().replace(/^file:\/\//, '')
  const location = candidate.match(/(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?)$/)
  if (location) candidate = candidate.slice(0, -location[0].length)
  try {
    candidate = decodeURIComponent(candidate)
  } catch {
    // 保留无法解码的原始文件名。
  }

  const normalizedWorkspace = workspacePath?.replace(/\\/g, '/').replace(/\/+$/, '')
  candidate = candidate.replace(/\\/g, '/')
  if (normalizedWorkspace && candidate.startsWith(`${normalizedWorkspace}/`)) {
    candidate = candidate.slice(normalizedWorkspace.length + 1)
  }
  candidate = candidate.replace(/^\.\//, '').replace(/^["'`]|["'`]$/g, '')

  const segments = candidate.split('/')
  if (
    !candidate ||
    candidate.startsWith('/') ||
    segments.some((segment) => segment === '..' || segment === '')
  ) {
    return null
  }

  const lineValue = location?.[1] ?? location?.[3]
  const columnValue = location?.[2] ?? location?.[4]
  return {
    relativePath: candidate,
    ...(lineValue !== undefined && { line: Number.parseInt(lineValue, 10) }),
    ...(columnValue !== undefined && { column: Number.parseInt(columnValue, 10) }),
  }
}

function fileName(relativePath: string): string {
  return relativePath.split('/').pop() ?? relativePath
}
