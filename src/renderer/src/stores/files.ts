import { useUiStore } from '@renderer/stores/ui'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type { DirEntry, FilePreview, ResolvedFileReference } from '@shared/ipc/fs'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export interface FilePreviewTab {
  relativePath: string
  /** 工作区外文件（如 `~/.claude.json`）的绝对路径；存在时预览/编辑走绝对路径通道。 */
  absolutePath?: string
  preview: FilePreview | null
  loading: boolean
  error: string | null
  /**
   * File Preview Tabs: 是否处于"预览态"（VS Code 风格的 transient tab）。
   * 来自文件树单击的文件为 true：在原位被后续单击的文件覆盖，双击/双击 tab 后转正。
   * 来自聊天引用、搜索结果等其他入口的为 false，作为常驻 tab。
   */
  isTransient: boolean
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
    absolutePath?: string,
    asTransient = false,
  ): Promise<FilePreview | null> {
    // File Preview Tabs (VS Code Preview Mode): asTransient=true 时，若当前活动 tab 仍是
    // 预览态，则用新文件原地替换它（复用同一个 tab 位），而非新增——模拟 VS Code 单击预览。
    // 已转正（非 transient）的 tab、以及来自其他入口（asTransient=false）的不受影响。
    if (asTransient) {
      const active = activePreviewTab.value
      if (active?.isTransient && active.relativePath !== relativePath) {
        replacePreviewTab(active.relativePath, relativePath, absolutePath)
      }
    }

    const tab = ensurePreviewTab(relativePath, absolutePath, asTransient)
    activePreviewPath.value = relativePath
    if (tab.preview && !force) return tab.preview

    tab.loading = true
    tab.error = null
    try {
      const rawPreview = await window.api.fs.readFilePreview({
        workspaceId,
        ...workspacePathArgument(workspaceId),
        relativePath,
        ...(absolutePath !== undefined && { absolutePath }),
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

  async function openFile(
    workspaceId: string,
    relativePath: string,
    absolutePath?: string,
  ): Promise<void> {
    useUiStore().showRightPanel('files')
    await previewFile(workspaceId, relativePath, false, absolutePath)
  }

  // Chat File Reference: 聊天区、工具调用和文件 pill 最终都汇聚到同一预览入口。
  async function openFileReference(workspaceId: string, reference: string): Promise<boolean> {
    const resolveReference = window.api.fs.resolveFileReference
    let resolved: ResolvedFileReference | null = null
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
    await openFile(workspaceId, resolved.relativePath, resolved.absolutePath)
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
      await previewFile(
        workspaceId,
        currentPreview.value.relativePath,
        true,
        activePreviewTab.value?.absolutePath,
      )
    }
  }

  async function openInEditor(
    workspaceId: string,
    relativePath: string,
    line?: number,
    absolutePath?: string,
  ): Promise<{ launched: boolean; error?: string }> {
    const result = await window.api.fs.openInEditor({
      workspaceId,
      relativePath,
      ...(absolutePath !== undefined && { absolutePath }),
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

  function closeOthersPreviews(keepPath: string): void {
    // File Preview Tabs: 关闭除 keepPath 外的所有 tab；活动 tab 被移除时回退到保留项。
    if (!previewTabs.value.some((tab) => tab.relativePath === keepPath)) return
    previewTabs.value = previewTabs.value.filter((tab) => tab.relativePath === keepPath)
    if (activePreviewPath.value !== keepPath) activePreviewPath.value = keepPath
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

  function ensurePreviewTab(
    relativePath: string,
    absolutePath?: string,
    asTransient = false,
  ): FilePreviewTab {
    const existing = previewTabs.value.find((tab) => tab.relativePath === relativePath)
    if (existing) {
      // 工作区外文件的 absolutePath 可能后于 tab 创建到达，补写进去。
      if (absolutePath !== undefined) existing.absolutePath = absolutePath
      // 重新打开某个 tab 时，非 transient 入口不应把已转正的 tab 重新降级为预览态。
      if (!asTransient) existing.isTransient = false
      return existing
    }
    const tab: FilePreviewTab = {
      relativePath,
      ...(absolutePath !== undefined && { absolutePath }),
      preview: null,
      loading: false,
      error: null,
      isTransient: asTransient,
    }
    previewTabs.value.push(tab)
    return previewTabs.value[previewTabs.value.length - 1]!
  }

  /**
   * File Preview Tabs (VS Code Preview Mode): 用新路径替换旧预览 tab 的槽位。
   * 保持顺序，丢弃旧 tab 的内容/加载态，让新文件作为新的预览态 tab。
   */
  function replacePreviewTab(oldPath: string, newPath: string, absolutePath?: string): void {
    const index = previewTabs.value.findIndex((tab) => tab.relativePath === oldPath)
    if (index === -1) return
    previewTabs.value[index] = {
      relativePath: newPath,
      ...(absolutePath !== undefined && { absolutePath }),
      preview: null,
      loading: false,
      error: null,
      isTransient: true,
    }
    if (activePreviewPath.value === oldPath) activePreviewPath.value = newPath
  }

  /** File Preview Tabs: 把指定 tab 转为常驻（双击 tab / 双击文件树时调用）。 */
  function pinPreviewTab(relativePath: string): void {
    const tab = previewTabs.value.find((item) => item.relativePath === relativePath)
    if (tab) tab.isTransient = false
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
    closeOthersPreviews,
    closeAllPreviews,
    pinPreviewTab,
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
): ResolvedFileReference | null {
  // Dev Runtime Compatibility: 本地解析只接受安全相对路径，最终读取仍由主进程校验。
  // 渲染端无 homedir，家目录路径（~/、$HOME/）与绝对路径一律拒绝——
  // 让主进程（重启后）成为权威解析者，而非在此错误跳转。
  let candidate = reference.trim().replace(/^file:\/\//, '')
  if (candidate.startsWith('~/') || candidate === '~') return null
  if (candidate.startsWith('$HOME/') || candidate === '$HOME') return null
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
