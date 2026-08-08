<template>
  <div class="h-full min-w-0 flex flex-col bg-card">
    <!-- File Tree Header: 展示工作区上下文，并集中提供搜索、刷新和折叠操作。 -->
    <div class="px-2.5 pt-2.5 pb-2 border-b border-border/70">
      <div class="flex items-center gap-2 mb-2">
        <div ref="folderSwitcherEl" class="relative min-w-0 flex-1">
          <button
            v-if="workspaceFolders.length > 1"
            type="button"
            class="folder-switcher-trigger"
            :class="folderMenuOpen ? 'border-ring/70 bg-accent/45 ring-1 ring-ring/15' : ''"
            title="切换工作区文件夹"
            aria-haspopup="listbox"
            :aria-expanded="folderMenuOpen"
            @click="folderMenuOpen = !folderMenuOpen"
          >
            <FileTypeIcon
              :name="selectedFolder?.alias ?? 'src'"
              is-directory
              expanded
              class="h-[18px] w-[18px] flex-shrink-0"
            />
            <span class="min-w-0 flex-1 text-left">
              <span class="flex min-w-0 items-center gap-1.5">
                <span class="truncate text-[length:var(--ui-text-d2)] font-semibold">
                  {{ selectedFolder?.alias }}
                </span>
                <span class="folder-role-badge">
                  {{ selectedFolder?.role === 'primary' ? '主文件夹' : '次文件夹' }}
                </span>
              </span>
              <span
                class="block truncate text-[length:var(--ui-text-d5)] leading-4 text-muted-foreground"
              >
                {{ selectedFolder?.path }}
              </span>
            </span>
            <ChevronDownIcon
              class="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform"
              :class="folderMenuOpen ? 'rotate-180 text-foreground' : ''"
            />
          </button>

          <div
            v-if="workspaceFolders.length > 1 && folderMenuOpen"
            class="folder-switcher-menu"
            role="listbox"
            aria-label="工作区文件夹"
          >
            <button
              v-for="folder in workspaceFolders"
              :key="folder.id"
              type="button"
              role="option"
              :aria-selected="folder.id === selectedFolderId"
              class="folder-switcher-option"
              :class="folder.id === selectedFolderId ? 'bg-accent/70' : ''"
              @click="selectFolder(folder.id)"
            >
              <FileTypeIcon
                :name="folder.alias"
                is-directory
                :expanded="folder.id === selectedFolderId"
                class="h-4 w-4 flex-shrink-0"
              />
              <span class="min-w-0 flex-1">
                <span class="flex min-w-0 items-center gap-1.5">
                  <span class="truncate text-[length:var(--ui-text-d2)] font-medium">
                    {{ folder.alias }}
                  </span>
                  <span class="folder-role-badge">
                    {{ folder.role === 'primary' ? '主文件夹' : '次文件夹' }}
                  </span>
                </span>
                <span
                  class="block truncate text-[length:var(--ui-text-d5)] leading-4 text-muted-foreground"
                >
                  {{ folder.path }}
                </span>
              </span>
              <CheckIcon
                v-if="folder.id === selectedFolderId"
                class="h-3.5 w-3.5 flex-shrink-0 text-foreground"
              />
              <span v-else class="h-3.5 w-3.5 flex-shrink-0" />
            </button>
          </div>

          <div v-if="workspaceFolders.length <= 1" class="flex min-w-0 items-center gap-2 py-0.5">
            <FileTypeIcon
              name="src"
              is-directory
              expanded
              class="h-[18px] w-[18px] flex-shrink-0"
            />
            <div class="min-w-0 flex-1">
              <div class="truncate text-[length:var(--ui-text-d2)] font-medium">
                {{ selectedFolder?.alias ?? workspaceStore.currentWorkspace?.name ?? 'Files' }}
              </div>
              <div class="truncate text-[length:var(--ui-text-d5)] text-muted-foreground">
                {{ selectedFolder?.path ?? workspaceStore.currentWorkspace?.path }}
              </div>
            </div>
          </div>
        </div>
        <!--
          File Preview Split: 单栏形态（窗口放不下预览 + 文件树并排）下，文件树占满整条
          面板，这是回到文件详情的唯一入口——并排时两边都在，按钮不出现。
        -->
        <button
          v-if="showPreviewButton"
          type="button"
          class="icon-button"
          title="返回文件详情"
          aria-label="返回文件详情"
          @click="emit('showPreview')"
        >
          <PanelLeftIcon class="w-3.5 h-3.5" />
        </button>
        <button type="button" class="icon-button" title="折叠全部" @click="filesStore.collapseAll">
          <ListTreeIcon class="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          class="icon-button"
          title="刷新文件树"
          :disabled="refreshing"
          @click="refresh"
        >
          <RefreshCwIcon :class="['w-3.5 h-3.5', refreshing ? 'animate-spin' : '']" />
        </button>
      </div>

      <label class="relative block">
        <SearchIcon
          class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground"
        />
        <input
          v-model="query"
          type="search"
          class="w-full h-7 rounded-md border border-border bg-background/70 pl-7 pr-7 text-[length:var(--ui-text-d3)] outline-none placeholder:text-muted-foreground focus:border-primary/60 focus:ring-1 focus:ring-primary/20"
          placeholder="搜索工作区文件"
          spellcheck="false"
        />
        <button
          v-if="query"
          type="button"
          class="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          title="清除搜索"
          @click="query = ''"
        >
          <XIcon class="w-3.5 h-3.5" />
        </button>
      </label>

      <div
        v-if="filesStore.requiresRestart"
        class="mt-2 rounded border border-warning/35 bg-warning/8 px-2 py-1.5 text-[length:var(--ui-text-d5)] leading-4 text-warning"
      >
        主进程仍是旧版本：文件树已兼容，重启应用后可使用完整搜索与媒体预览。
      </div>
    </div>

    <!-- File Tree Body: 搜索结果与懒加载目录树共用内容区域，但状态互不覆盖。 -->
    <div class="flex-1 overflow-y-auto py-1.5 px-1">
      <div
        v-if="!workspaceStore.currentWorkspace"
        class="h-full grid place-items-center px-6 text-center text-[length:var(--ui-text-d3)] text-muted-foreground"
      >
        请先选择工作区
      </div>

      <template v-else-if="query.trim()">
        <div v-if="filesStore.searchLoading" class="file-state">
          <LoaderCircleIcon class="w-4 h-4 animate-spin" />
          正在搜索…
        </div>
        <div v-else-if="filesStore.searchResults.length === 0" class="file-state">
          <SearchXIcon class="w-5 h-5" />
          没有匹配的文件
        </div>
        <button
          v-for="entry in filesStore.searchResults"
          v-else
          :key="entry.relativePath"
          type="button"
          class="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/70 text-left"
          @click="openSearchResult(entry)"
          @contextmenu.prevent="openContextMenu(entry, $event)"
        >
          <FileTypeIcon
            :name="entry.name"
            :is-directory="entry.isDirectory"
            class="w-4 h-4 flex-shrink-0"
          />
          <span class="min-w-0 flex-1">
            <span class="block text-[length:var(--ui-text-d3)] truncate">{{ entry.name }}</span>
            <span class="block text-[length:var(--ui-text-d5)] text-muted-foreground truncate">
              {{ parentPath(entry.relativePath) }}
            </span>
          </span>
        </button>
      </template>

      <template v-else>
        <div v-if="rootLoading && rootEntries.length === 0" class="file-state">
          <LoaderCircleIcon class="w-4 h-4 animate-spin" />
          正在读取文件…
        </div>
        <div v-else-if="rootError" class="file-state text-danger">
          <CircleAlertIcon class="w-5 h-5" />
          <span>无法读取工作区</span>
          <button class="text-primary hover:underline" @click="loadRoot(true)">重试</button>
        </div>
        <div v-else-if="rootEntries.length === 0" class="file-state">
          <FolderOpenIcon class="w-5 h-5" />
          工作区为空
        </div>
        <FileTreeNode
          v-for="entry in rootEntries"
          v-else
          :key="entry.relativePath"
          :workspace-id="workspaceStore.currentWorkspace.id"
          :entry="entry"
          :depth="0"
        />
      </template>
    </div>

    <div
      class="h-7 px-3 border-t border-border/60 flex items-center text-[length:var(--ui-text-d5)] text-muted-foreground"
    >
      <span v-if="query.trim()">{{ filesStore.searchResults.length }} 个结果</span>
      <span v-else>{{ rootEntries.length }} 个顶层项目</span>
      <span class="ml-auto">单击预览 · 双击常驻</span>
    </div>

    <!--
      File Mention: 整棵树共用一个右键菜单实例（含递归节点和搜索结果），
      由 provide 下发开启回调，见 file-tree-menu.ts。
    -->
    <ContextMenu
      v-if="contextMenu"
      :x="contextMenu.x"
      :y="contextMenu.y"
      :items="contextMenuItems"
      @select="onContextMenuSelect"
      @open-parent="onContextMenuOpenParent"
      @close="contextMenu = null"
    />
  </div>
</template>

<script setup lang="ts">
import { ContextMenu, type ContextMenuItem } from '@renderer/components/ui/context-menu'
import { useOpenWith } from '@renderer/composables/useOpenWith'
import { useChatInputStore } from '@renderer/stores/chat-input'
import { useFilesStore } from '@renderer/stores/files'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type { DirEntry } from '@shared/ipc/fs'
import {
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  FolderOpenIcon,
  FolderSearchIcon,
  ListTreeIcon,
  LoaderCircleIcon,
  MessageSquarePlusIcon,
  PanelLeftIcon,
  RefreshCwIcon,
  SearchIcon,
  SearchXIcon,
  XIcon,
  ExternalLinkIcon,
  ClipboardIcon,
  ClipboardPasteIcon,
} from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, provide, ref, watch } from 'vue'

import { FILE_TREE_MENU_KEY } from './file-tree-menu'
import FileTreeNode from './FileTreeNode.vue'
import FileTypeIcon from './FileTypeIcon.vue'

defineProps<{
  /** File Preview Split: 单栏形态下显示"返回文件详情"按钮，见 RightPanel。 */
  showPreviewButton?: boolean
}>()
const emit = defineEmits<{ showPreview: [] }>()

const workspaceStore = useWorkspaceStore()
const filesStore = useFilesStore()
const chatInput = useChatInputStore()
const query = ref('')
const workspaceFolders = computed(() => workspaceStore.currentWorkspace?.folders ?? [])
const selectedFolderId = ref('')
const folderMenuOpen = ref(false)
const folderSwitcherEl = ref<HTMLElement | null>(null)
const selectedFolder = computed(
  () =>
    workspaceFolders.value.find((folder) => folder.id === selectedFolderId.value) ??
    workspaceFolders.value.find((folder) => folder.role === 'primary'),
)

// File Mention: 右键菜单——树里任意节点和搜索结果共用这一个实例。
// contextMenuItems 是 ref（非 computed）：「打开方式」的子菜单要在 hover 时懒加载，
// 必须能就地替换 children。
// Open With 的平台判断、应用查询、打开逻辑统一走 useOpenWith 单例（与聊天顶部选择器、
// 引用 pill 图标点击共享同一份状态）。
const contextMenu = ref<{ x: number; y: number; entry: DirEntry } | null>(null)
const contextMenuItems = ref<ContextMenuItem[]>([])
// 缓存本次菜单会话解析出的绝对路径——复制/打开/Finder 都要用，避免每个动作各解析一次。
const contextMenuAbsPath = ref<string | null>(null)
const { platform: openWithPlatform, initOpenWith, listInstalledApps, openWith } = useOpenWith()

/**「在 Finder / 资源管理器中显示」文案随平台变——与 SessionList 的约定一致 */
const revealLabel = computed(() =>
  openWithPlatform.value === 'darwin' ? '在 Finder 中显示' : '在文件资源管理器中显示',
)

/**
 * 打开右键菜单：先解析绝对路径，再构建条目。
 * 路径解析走 fs.resolveFileReference（工作区边界校验在那里），失败时各打开类动作自检兜底。
 */
function openContextMenu(entry: DirEntry, event: MouseEvent): void {
  contextMenu.value = { x: event.clientX, y: event.clientY, entry }
  contextMenuAbsPath.value = null
  void resolveMenuAbsPath(entry)
  contextMenuItems.value = buildMenuItems(entry)
}
provide(FILE_TREE_MENU_KEY, openContextMenu)

async function resolveMenuAbsPath(entry: DirEntry): Promise<void> {
  const workspace = workspaceStore.currentWorkspace
  if (!workspace) return
  const reference = entry.folderAlias
    ? `${entry.folderAlias}/${entry.relativePath}`
    : entry.relativePath
  try {
    const resolved = await window.api.fs.resolveFileReference({
      workspaceId: workspace.id,
      ...(entry.folderId !== undefined && { folderId: entry.folderId }),
      reference,
      allowDirectory: entry.isDirectory,
    })
    // 工作区内文件 resolveFileReference 只回 relativePath（absolutePath 仅工作区外文件有）。
    // 拿绝对路径必须由 folder.path + relativePath 拼回——与 readFilePreview/openInEditor 的约定一致。
    if (!resolved) {
      contextMenuAbsPath.value = null
    } else if (resolved.absolutePath) {
      contextMenuAbsPath.value = resolved.absolutePath
    } else {
      const folder =
        workspace.folders.find((item) => item.id === resolved.folderId) ?? selectedFolder.value
      contextMenuAbsPath.value = folder ? `${folder.path}/${resolved.relativePath}` : null
    }
  } catch {
    contextMenuAbsPath.value = null
  }
}

function buildMenuItems(_entry: DirEntry): ContextMenuItem[] {
  const items: ContextMenuItem[] = [{ key: 'open', label: '打开', icon: ExternalLinkIcon }]
  // 「打开方式」仅 macOS——列表与顶部选择器一致（Finder + 白名单 IDE），文件和目录都显示
  // （Finder 定位目录、IDE 打开为项目，对目录都有意义）。
  if (openWithPlatform.value === 'darwin') {
    items.push({
      key: 'open-with',
      label: '打开方式',
      icon: ExternalLinkIcon,
      // 子菜单先放占位，hover 时由 onContextMenuOpenParent 懒加载填充真实应用
      children: [{ key: 'loading', label: '正在读取…', disabled: true }],
    })
  }
  items.push({ key: 'reveal', label: revealLabel.value, icon: FolderSearchIcon })
  items.push({ key: 'copy-abs', label: '复制绝对路径', icon: ClipboardPasteIcon })
  items.push({ key: 'copy-rel', label: '复制相对路径', icon: ClipboardIcon })
  items.push({ separator: true, key: 'sep', label: '' })
  items.push({ key: 'mention', label: '添加到对话', icon: MessageSquarePlusIcon })
  return items
}

/**
 * ContextMenu 在带 children 的父条目被 hover 时回传 openParent——
 * 在此刻填充子菜单。已加载过则跳过。
 *
 * 应用列表与顶部「打开方式」选择器完全一致（走 useOpenWith.listInstalledApps：
 * Finder + 白名单 IDE，带图标），不再按具体文件查 Launch Services——这样两处入口
 * 看到的应用集合统一，用户在顶部选好的应用这里也在。
 */
async function onContextMenuOpenParent(key: string): Promise<void> {
  if (key !== 'open-with') return
  const items = contextMenuItems.value
  const parent = items.find((item) => item.key === 'open-with')
  if (!parent?.children) return
  // 已加载过真实列表（不再是单一占位条目）就不再重复查询
  if (parent.children.length !== 1 || parent.children[0]?.key !== 'loading') return
  const apps = await listInstalledApps()
  parent.children =
    apps.length > 0
      ? apps.map((app) => ({
          key: app.path,
          label: app.name,
          ...(app.icon && { iconUrl: app.icon }),
        }))
      : [{ key: 'empty', label: '无可用应用', disabled: true }]
  // 触发 contextMenuItems 的响应式更新（数组内部已变，赋同一引用让 deep watch 生效）
  contextMenuItems.value = [...items]
}

function onContextMenuSelect(key: string): void {
  const entry = contextMenu.value?.entry
  if (!entry) return
  // 「打开方式」子项：key 形如 `open-with/<appPath>`
  if (key.startsWith('open-with/')) {
    void openWith(contextMenuAbsPath.value ?? '', {
      name: '',
      path: key.slice('open-with/'.length),
    })
    return
  }
  switch (key) {
    case 'open':
      void openWith(contextMenuAbsPath.value ?? '')
      break
    case 'reveal':
      void handleReveal()
      break
    case 'copy-abs':
      void handleCopyAbs()
      break
    case 'copy-rel':
      handleCopyRel(entry)
      break
    case 'mention':
      chatInput.addFileMention(
        entry.folderAlias ? `${entry.folderAlias}/${entry.relativePath}` : entry.relativePath,
      )
      break
  }
}

async function handleReveal(): Promise<void> {
  const absPath = contextMenuAbsPath.value
  if (!absPath) return
  await window.api.system.showItemInFolder({ path: absPath })
}

async function handleCopyAbs(): Promise<void> {
  const absPath = contextMenuAbsPath.value
  if (absPath) await navigator.clipboard.writeText(absPath)
}

function handleCopyRel(entry: DirEntry): void {
  const reference = entry.folderAlias
    ? `${entry.folderAlias}/${entry.relativePath}`
    : entry.relativePath
  void navigator.clipboard.writeText(reference)
}
const refreshing = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null

const rootEntries = computed(
  () =>
    filesStore.directoryCache.get(selectedFolderId.value ? `${selectedFolderId.value}:` : '') ?? [],
)
const rootLoading = computed(() => filesStore.loadingPaths.has(''))
const rootError = computed(() => filesStore.directoryErrors.get(''))

// File Tree Workspace Binding: 挂载时仅加载根目录；仅在工作区真正切换时才 reset，
// 避免面板首次打开（FileTree 挂载）时误清空正在进行的文件预览（previewTabs）。
// 旧实现用 { immediate: true }，会在挂载瞬间无条件 reset，与并发进行的 previewFile
// IPC 产生竞态：readFilePreview 的 await 期间 Vue 挂载 FileTree → immediate watch 触发
// reset() → previewTabs 被清空 → 预览面板永远无法显示（直到面板被关闭再重开）。
onMounted(async () => {
  document.addEventListener('click', closeFolderMenuOnOutsideClick, true)
  selectPrimaryFolder()
  if (workspaceStore.currentWorkspace?.id) void loadRoot()
  // 右键菜单的「在 Finder 中显示 / 打开方式」文案与可见性按平台变，
  // 走 useOpenWith 单例（与聊天顶部选择器、引用 pill 共享平台/选中应用状态）。
  void initOpenWith()
})

watch(
  () => workspaceStore.currentWorkspace?.id,
  (workspaceId, prevId) => {
    if (workspaceId === prevId) return
    filesStore.reset()
    query.value = ''
    selectPrimaryFolder()
    if (workspaceId) void loadRoot()
  },
)

watch(query, (value) => {
  // File Tree Search: 短防抖避免输入过程中频繁跨进程遍历工作区。
  if (searchTimer) clearTimeout(searchTimer)
  const workspaceId = workspaceStore.currentWorkspace?.id
  if (!workspaceId) return
  searchTimer = setTimeout(
    () => void filesStore.search(workspaceId, value, selectedFolder.value?.id),
    180,
  )
})

watch(selectedFolderId, (folderId, previousId) => {
  if (!folderId || folderId === previousId) return
  filesStore.resetDirectoryState()
  query.value = ''
  void loadRoot()
})

onUnmounted(() => {
  document.removeEventListener('click', closeFolderMenuOnOutsideClick, true)
  if (searchTimer) clearTimeout(searchTimer)
})

function selectFolder(folderId: string): void {
  selectedFolderId.value = folderId
  folderMenuOpen.value = false
}

function closeFolderMenuOnOutsideClick(event: MouseEvent): void {
  if (!folderMenuOpen.value) return
  if (!folderSwitcherEl.value?.contains(event.target as Node)) folderMenuOpen.value = false
}

async function loadRoot(force = false): Promise<void> {
  const workspaceId = workspaceStore.currentWorkspace?.id
  if (!workspaceId) return
  await filesStore.openDirectory(workspaceId, '', force, selectedFolder.value?.id)
}

async function refresh(): Promise<void> {
  const workspaceId = workspaceStore.currentWorkspace?.id
  if (!workspaceId || refreshing.value) return
  refreshing.value = true
  try {
    await filesStore.refresh(workspaceId, selectedFolder.value?.id)
    if (query.value) await filesStore.search(workspaceId, query.value, selectedFolder.value?.id)
  } finally {
    refreshing.value = false
  }
}

function selectPrimaryFolder(): void {
  selectedFolderId.value =
    workspaceFolders.value.find((folder) => folder.role === 'primary')?.id ?? ''
}

async function openSearchResult(entry: DirEntry): Promise<void> {
  const workspaceId = workspaceStore.currentWorkspace?.id
  if (!workspaceId) return
  if (entry.isDirectory) {
    query.value = ''
    await filesStore.toggleDirectory(workspaceId, entry)
  } else {
    await filesStore.previewFile(
      workspaceId,
      entry.relativePath,
      false,
      undefined,
      false,
      entry.folderId,
      entry.folderAlias,
    )
  }
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '项目根目录' : path.slice(0, index)
}
</script>

<style scoped>
@reference "../../assets/styles/main.css";

.icon-button {
  @apply w-6 h-6 grid place-items-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50;
}

.file-state {
  @apply min-h-28 flex flex-col items-center justify-center gap-2 text-[length:var(--ui-text-d3)] text-muted-foreground;
}

.folder-switcher-trigger {
  @apply flex min-h-10 w-full items-center gap-2 rounded-md border border-border/80 bg-background/70 px-2 py-1 text-left outline-none transition-colors hover:border-border hover:bg-accent/35 focus-visible:ring-1 focus-visible:ring-ring;
}

.folder-switcher-menu {
  @apply absolute left-0 right-0 top-full z-50 mt-1 min-w-56 rounded-lg border border-border bg-popover p-1.5 shadow-xl;
}

.folder-switcher-option {
  @apply flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-popover-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent;
}

.folder-role-badge {
  @apply flex-shrink-0 rounded border border-border/70 bg-muted/70 px-1 py-px text-[9px] font-medium leading-3 text-muted-foreground;
}
</style>
