<template>
  <!--
    Review File Tree: 把 ReviewFile.path 字符串聚合成目录树。

    与工作区 FileTree 不同——这里只展示「本轮被改动的文件」，数据全在内存
    （ReviewFile[]），不需要懒加载 IPC。所以自建一个轻量树组件，
    复用 FileTypeIcon 做图标，样式跟 FileTreeNode 保持一致（缩进/chevron/选中态）。

    默认全部展开：一轮变更的文件通常不多，默认展开省去用户逐层点开。
  -->
  <div class="flex h-full flex-col">
    <!-- header：变更文件数 + 总 +/- 统计 -->
    <div
      class="flex items-center gap-2 border-b border-border px-3 py-2 text-[length:var(--ui-text-d3)] text-muted-foreground"
    >
      <span class="font-medium text-foreground">{{ files.length }} 个文件</span>
      <span class="font-mono tabular-nums">
        <span class="text-emerald-500">+{{ totalAdditions }}</span>
        <span class="ml-1 text-red-500">-{{ totalDeletions }}</span>
      </span>
    </div>

    <!-- 树体 -->
    <div class="flex-1 overflow-y-auto py-1">
      <ReviewFileTreeNode
        v-for="node in tree"
        :key="node.path"
        :node="node"
        :depth="0"
        :selected-path="selectedPath"
        :expanded-set="expandedSet"
        @toggle-dir="onToggleDir"
        @select-file="onSelectFile"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ReviewFile } from '@renderer/lib/review'
import { buildReviewTree, collectReviewDirPaths } from '@renderer/lib/review-tree'
import { computed, ref, watch } from 'vue'

import ReviewFileTreeNode from './ReviewFileTreeNode.vue'

const props = defineProps<{
  files: ReviewFile[]
  selectedPath: string | null
}>()

const emit = defineEmits<{
  select: [path: string]
}>()

/** 把扁平 path 列表聚合成嵌套树（逻辑在 lib/review-tree，便于单测）。 */
const tree = computed(() => buildReviewTree(props.files))

const totalAdditions = computed(() => props.files.reduce((sum, f) => sum + f.stats.additions, 0))
const totalDeletions = computed(() => props.files.reduce((sum, f) => sum + f.stats.deletions, 0))

/** 展开的目录 path 集合。files 变化时默认全部展开（见 watch）。 */
const expandedSet = ref<Set<string>>(new Set())

watch(
  () => props.files,
  (files) => {
    // 默认展开所有目录节点——变更文件少，逐层点开太累
    const all = new Set<string>()
    collectReviewDirPaths(files).forEach((p) => all.add(p))
    expandedSet.value = all
  },
  { immediate: true },
)

function onToggleDir(path: string): void {
  const next = new Set(expandedSet.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  expandedSet.value = next
}

function onSelectFile(path: string): void {
  emit('select', path)
}
</script>
