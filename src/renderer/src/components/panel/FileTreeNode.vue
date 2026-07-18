<template>
  <div>
    <!-- 加载子目录 -->
    <button
      v-for="entry in entries"
      :key="entry.relativePath"
      :class="[
        'w-full flex items-center gap-1 text-xs hover:bg-muted rounded',
        active(entry.relativePath) ? 'bg-muted' : '',
      ]"
      :style="{ paddingLeft: `${depth * 12 + 8}px` }"
      @click="onClick(entry)"
    >
      <!-- 展开/折叠箭头 -->
      <ChevronRightIcon
        v-if="entry.isDirectory"
        :class="[
          'w-3 h-3 flex-shrink-0 transition-transform',
          expanded.has(entry.relativePath) ? 'rotate-90' : '',
        ]"
      />
      <span v-else class="w-3 h-3 flex-shrink-0" />

      <!-- 图标 -->
      <FolderIcon v-if="entry.isDirectory" class="w-3 h-3 text-muted-foreground flex-shrink-0" />
      <FileIcon v-else class="w-3 h-3 text-muted-foreground flex-shrink-0" />

      <!-- 名字 -->
      <span class="truncate flex-1 text-left">{{ entry.name }}</span>
    </button>

    <!-- 子目录递归 -->
    <FileTreeNode
      v-for="child of expandedChildren"
      :key="child.relativePath"
      :workspace-path="workspacePath"
      :workspace-id="workspaceId"
      :relative-path="child.relativePath"
      :depth="depth + 1"
    />
  </div>
</template>

<script setup lang="ts">
import { useFilesStore } from '@renderer/stores/files'
import type { DirEntry } from '@shared/ipc/fs'
import { ChevronRightIcon, FileIcon, FolderIcon } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  workspacePath: string
  workspaceId: string
  relativePath: string
  depth: number
}>()

const filesStore = useFilesStore()
const entries = ref<DirEntry[]>([])
const expanded = ref(new Set<string>())

async function load(): Promise<void> {
  entries.value = await filesStore.openDirectory(props.workspacePath, props.relativePath)
}

watch(
  () => props.relativePath,
  () => {
    void load()
  },
  { immediate: true },
)

async function onClick(entry: DirEntry): Promise<void> {
  if (entry.isDirectory) {
    if (expanded.value.has(entry.relativePath)) {
      expanded.value.delete(entry.relativePath)
    } else {
      expanded.value.add(entry.relativePath)
    }
    expanded.value = new Set(expanded.value)
  } else {
    // 文件：预览
    await filesStore.previewFile(props.workspacePath, entry.relativePath)
  }
}

function active(relativePath: string): boolean {
  return filesStore.currentPreview?.relativePath === relativePath
}

// 展开的子节点的 relativePath 列表（用于递归渲染）
const expandedChildren = computed(() =>
  entries.value.filter((e) => e.isDirectory && expanded.value.has(e.relativePath)),
)
</script>
