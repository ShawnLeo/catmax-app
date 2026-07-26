<template>
  <!--
    Review File Tree 的递归节点。样式对齐 FileTreeNode（缩进/chevron/选中态），
    但数据来自父组件构建好的 TreeNode，不耦合 filesStore。
  -->
  <div>
    <button
      type="button"
      :class="[
        'group flex h-7 w-full items-center rounded-md pr-2 text-[13px] transition-colors',
        isSelected ? 'bg-primary/10 text-foreground' : 'text-foreground/85 hover:bg-muted/70',
      ]"
      :style="{ paddingLeft: `${depth * 14 + 6}px` }"
      :title="node.path"
      @click="onClick"
    >
      <span class="grid h-4 w-4 flex-shrink-0 place-items-center">
        <ChevronRightIcon
          v-if="node.dir"
          :class="[
            'h-3.5 w-3.5 text-muted-foreground transition-transform duration-150',
            isExpanded ? 'rotate-90' : '',
          ]"
        />
      </span>
      <FileTypeIcon
        :name="node.name"
        :is-directory="node.dir"
        :expanded="isExpanded"
        class="mr-1.5 h-4 w-4 flex-shrink-0"
      />
      <span class="truncate text-left">{{ node.name }}</span>
      <!-- 文件节点：右侧 +/- 统计 -->
      <span
        v-if="!node.dir && node.change"
        class="ml-auto flex-shrink-0 font-mono text-[11px] tabular-nums"
      >
        <span class="text-emerald-500">+{{ node.change.stats.additions }}</span>
        <span class="ml-1 text-red-500">-{{ node.change.stats.deletions }}</span>
      </span>
    </button>

    <template v-if="node.dir && isExpanded">
      <ReviewFileTreeNode
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        :selected-path="selectedPath"
        :expanded-set="expandedSet"
        @toggle-dir="(p: string) => emit('toggleDir', p)"
        @select-file="(p: string) => emit('selectFile', p)"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { ChevronRightIcon } from 'lucide-vue-next'
import { computed } from 'vue'

import FileTypeIcon from './FileTypeIcon.vue'

/**
 * 节点最小契约——结构上兼容父组件的 TreeNode（含 name/path/dir/children/change）。
 * 用 interface 自引用描述递归形状；change 只取展示需要的 stats 子集。
 */
interface ReviewTreeNode {
  name: string
  path: string
  dir: boolean
  children: ReviewTreeNode[]
  change?: { stats: { additions: number; deletions: number } }
}

const props = defineProps<{
  node: ReviewTreeNode
  depth: number
  selectedPath: string | null
  expandedSet: Set<string>
}>()

const emit = defineEmits<{
  toggleDir: [path: string]
  selectFile: [path: string]
}>()

const isExpanded = computed(() => props.expandedSet.has(props.node.path))
const isSelected = computed(() => !props.node.dir && props.selectedPath === props.node.path)

function onClick(): void {
  if (props.node.dir) {
    emit('toggleDir', props.node.path)
  } else {
    emit('selectFile', props.node.path)
  }
}
</script>
