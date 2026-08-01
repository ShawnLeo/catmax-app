<template>
  <div>
    <!-- File Tree Node: 单击目录懒加载子项，单击文件在左侧预览区打开或激活 tab。 -->
    <button
      type="button"
      :class="[
        'group w-full h-7 flex items-center pr-2 rounded-md text-[length:var(--ui-text-d2)] transition-colors',
        active ? 'bg-primary/10 text-foreground' : 'text-foreground/85 hover:bg-muted/70',
      ]"
      :style="{ paddingLeft: `${depth * 14 + 6}px` }"
      :title="entry.isSymlink ? `${entry.relativePath}（符号链接）` : entry.relativePath"
      @click="onClick"
      @dblclick="onDoubleClick"
    >
      <span class="w-4 h-4 grid place-items-center flex-shrink-0">
        <LoaderCircleIcon v-if="loading" class="w-3 h-3 text-muted-foreground animate-spin" />
        <ChevronRightIcon
          v-else-if="entry.isDirectory && !entry.isSymlink"
          :class="[
            'w-3.5 h-3.5 text-muted-foreground transition-transform duration-150',
            expanded ? 'rotate-90' : '',
          ]"
        />
      </span>
      <FileTypeIcon
        :name="entry.name"
        :is-directory="entry.isDirectory"
        :expanded="expanded"
        class="w-4 h-4 flex-shrink-0 mr-1.5"
      />
      <span class="truncate text-left">{{ entry.name }}</span>
      <Link2Icon
        v-if="entry.isSymlink"
        class="w-3 h-3 ml-auto text-muted-foreground flex-shrink-0"
      />
    </button>

    <template v-if="expanded">
      <FileTreeNode
        v-for="child in children"
        :key="child.relativePath"
        :entry="child"
        :workspace-id="workspaceId"
        :depth="depth + 1"
      />
      <div
        v-if="error"
        class="pr-2 py-1 text-[length:var(--ui-text-d4)] text-danger truncate"
        :style="{ paddingLeft: `${(depth + 1) * 14 + 26}px` }"
        :title="error"
      >
        无法读取目录
      </div>
      <div
        v-else-if="!loading && children.length === 0"
        class="pr-2 py-1 text-[length:var(--ui-text-d4)] text-muted-foreground"
        :style="{ paddingLeft: `${(depth + 1) * 14 + 26}px` }"
      >
        空目录
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useFilesStore } from '@renderer/stores/files'
import type { DirEntry } from '@shared/ipc/fs'
import { ChevronRightIcon, Link2Icon, LoaderCircleIcon } from 'lucide-vue-next'
import { computed, onBeforeUnmount } from 'vue'

import FileTypeIcon from './FileTypeIcon.vue'

const props = defineProps<{
  workspaceId: string
  entry: DirEntry
  depth: number
}>()

const filesStore = useFilesStore()
// File Tree Node: 递归节点只从 store 读取共享缓存，避免每层重复发起 IPC。
const expanded = computed(() => filesStore.expandedPaths.has(props.entry.relativePath))
const loading = computed(() => filesStore.loadingPaths.has(props.entry.relativePath))
const children = computed(() => filesStore.directoryCache.get(props.entry.relativePath) ?? [])
const error = computed(() => filesStore.directoryErrors.get(props.entry.relativePath))
const active = computed(() => filesStore.currentPreview?.relativePath === props.entry.relativePath)

// File Preview Tabs (VS Code Preview Mode): 单击打开预览态（italic、可被后续单击覆盖），
// 双击把 tab 转正（常驻）。用定时器区分单/双击——浏览器 dblclick 前会先触发两次 click。
// 目录切换不需要区分，立即响应，避免展开/折叠有延迟。
let clickTimer: ReturnType<typeof setTimeout> | null = null
const DBL_CLICK_DELAY = 250

async function onClick(): Promise<void> {
  if (props.entry.isDirectory) {
    await filesStore.toggleDirectory(props.workspaceId, props.entry)
    return
  }
  if (clickTimer) {
    clearTimeout(clickTimer)
    clickTimer = null
  }
  clickTimer = setTimeout(() => {
    clickTimer = null
    void filesStore.previewFile(props.workspaceId, props.entry.relativePath, false, undefined, true)
  }, DBL_CLICK_DELAY)
}

async function onDoubleClick(): Promise<void> {
  if (props.entry.isDirectory) return
  if (clickTimer) {
    clearTimeout(clickTimer)
    clickTimer = null
  }
  // 双击文件：作为常驻 tab 打开（asTransient=false），并立即转正。
  await filesStore.previewFile(props.workspaceId, props.entry.relativePath)
  filesStore.pinPreviewTab(props.entry.relativePath)
}

// 卸载时丢弃待触发的单击预览，避免在节点已销毁后还写入 store。
onBeforeUnmount(() => {
  if (clickTimer) {
    clearTimeout(clickTimer)
    clickTimer = null
  }
})
</script>
