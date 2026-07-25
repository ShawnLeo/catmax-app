<template>
  <div class="h-full min-w-0 flex flex-col bg-card">
    <!-- File Tree Header: 展示工作区上下文，并集中提供搜索、刷新和折叠操作。 -->
    <div class="px-2.5 pt-2.5 pb-2 border-b border-border/70">
      <div class="flex items-center gap-2 mb-2">
        <FileTypeIcon name="src" is-directory expanded class="w-[18px] h-[18px] flex-shrink-0" />
        <div class="min-w-0 flex-1">
          <div class="text-[13px] font-medium truncate">
            {{ workspaceStore.currentWorkspace?.name ?? 'Files' }}
          </div>
          <div class="text-[10px] text-muted-foreground truncate">
            {{ workspaceStore.currentWorkspace?.path }}
          </div>
        </div>
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
          class="w-full h-7 rounded-md border border-border bg-background/70 pl-7 pr-7 text-xs outline-none placeholder:text-muted-foreground focus:border-primary/60 focus:ring-1 focus:ring-primary/20"
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
        class="mt-2 rounded border border-warning/35 bg-warning/8 px-2 py-1.5 text-[10px] leading-4 text-warning"
      >
        主进程仍是旧版本：文件树已兼容，重启应用后可使用完整搜索与媒体预览。
      </div>
    </div>

    <!-- File Tree Body: 搜索结果与懒加载目录树共用内容区域，但状态互不覆盖。 -->
    <div class="flex-1 overflow-y-auto py-1.5 px-1">
      <div
        v-if="!workspaceStore.currentWorkspace"
        class="h-full grid place-items-center px-6 text-center text-xs text-muted-foreground"
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
        >
          <FileTypeIcon
            :name="entry.name"
            :is-directory="entry.isDirectory"
            class="w-4 h-4 flex-shrink-0"
          />
          <span class="min-w-0 flex-1">
            <span class="block text-[12px] truncate">{{ entry.name }}</span>
            <span class="block text-[10px] text-muted-foreground truncate">
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
      class="h-7 px-3 border-t border-border/60 flex items-center text-[10px] text-muted-foreground"
    >
      <span v-if="query.trim()">{{ filesStore.searchResults.length }} 个结果</span>
      <span v-else>{{ rootEntries.length }} 个顶层项目</span>
      <span class="ml-auto">单击预览 · 双击常驻</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useFilesStore } from '@renderer/stores/files'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type { DirEntry } from '@shared/ipc/fs'
import {
  CircleAlertIcon,
  FolderOpenIcon,
  ListTreeIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SearchIcon,
  SearchXIcon,
  XIcon,
} from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import FileTreeNode from './FileTreeNode.vue'
import FileTypeIcon from './FileTypeIcon.vue'

const workspaceStore = useWorkspaceStore()
const filesStore = useFilesStore()
const query = ref('')
const refreshing = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null

const rootEntries = computed(() => filesStore.directoryCache.get('') ?? [])
const rootLoading = computed(() => filesStore.loadingPaths.has(''))
const rootError = computed(() => filesStore.directoryErrors.get(''))

// File Tree Workspace Binding: 挂载时仅加载根目录；仅在工作区真正切换时才 reset，
// 避免面板首次打开（FileTree 挂载）时误清空正在进行的文件预览（previewTabs）。
// 旧实现用 { immediate: true }，会在挂载瞬间无条件 reset，与并发进行的 previewFile
// IPC 产生竞态：readFilePreview 的 await 期间 Vue 挂载 FileTree → immediate watch 触发
// reset() → previewTabs 被清空 → 预览面板永远无法显示（直到面板被关闭再重开）。
onMounted(() => {
  if (workspaceStore.currentWorkspace?.id) void loadRoot()
})

watch(
  () => workspaceStore.currentWorkspace?.id,
  (workspaceId, prevId) => {
    if (workspaceId === prevId) return
    filesStore.reset()
    query.value = ''
    if (workspaceId) void loadRoot()
  },
)

watch(query, (value) => {
  // File Tree Search: 短防抖避免输入过程中频繁跨进程遍历工作区。
  if (searchTimer) clearTimeout(searchTimer)
  const workspaceId = workspaceStore.currentWorkspace?.id
  if (!workspaceId) return
  searchTimer = setTimeout(() => void filesStore.search(workspaceId, value), 180)
})

onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

async function loadRoot(force = false): Promise<void> {
  const workspaceId = workspaceStore.currentWorkspace?.id
  if (!workspaceId) return
  await filesStore.openDirectory(workspaceId, '', force)
}

async function refresh(): Promise<void> {
  const workspaceId = workspaceStore.currentWorkspace?.id
  if (!workspaceId || refreshing.value) return
  refreshing.value = true
  try {
    await filesStore.refresh(workspaceId)
    if (query.value) await filesStore.search(workspaceId, query.value)
  } finally {
    refreshing.value = false
  }
}

async function openSearchResult(entry: DirEntry): Promise<void> {
  const workspaceId = workspaceStore.currentWorkspace?.id
  if (!workspaceId) return
  if (entry.isDirectory) {
    query.value = ''
    await filesStore.toggleDirectory(workspaceId, entry)
  } else {
    await filesStore.previewFile(workspaceId, entry.relativePath)
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
  @apply min-h-28 flex flex-col items-center justify-center gap-2 text-xs text-muted-foreground;
}
</style>
