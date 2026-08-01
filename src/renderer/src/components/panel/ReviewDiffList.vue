<template>
  <!--
    Review Diff List: 所有变更文件的可折叠卡片列表。

    每个文件一张卡片：
    - 收起态：文件图标 + 路径 + +/- 统计 + chevron（整行可点切换展开）
    - 展开态：卡片下方渲染该文件的 <DiffView>（统一/拆分由 reviewDiffMode 决定）

    多文件可同时展开。展开状态存在 uiStore.reviewExpandedPaths，
    这样从 CodexChangesCard 点具体文件进入时（showReview focusPath）能自动展开对应卡片。
    选中的 focusPath 卡片会滚动定位到视口。
  -->
  <div class="review-diff-list">
    <div
      v-for="file in uiStore.reviewFiles"
      :key="file.path"
      ref="cardRefs"
      class="border-b border-border last:border-b-0"
      :data-path="file.path"
    >
      <!-- 卡片头：整行可点切换展开 -->
      <button
        type="button"
        :class="[
          'flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[length:var(--ui-text-d2)] transition-colors',
          uiStore.reviewSelectedPath === file.path
            ? 'bg-primary/5 text-foreground'
            : 'text-foreground/85 hover:bg-muted/50',
        ]"
        :title="file.path"
        @click="onToggle(file.path)"
      >
        <ChevronRightIcon
          :class="[
            'h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform duration-150',
            isExpanded(file.path) ? 'rotate-90' : '',
          ]"
        />
        <FileTypeIcon :name="fileName(file.path)" class="h-4 w-4 flex-shrink-0" />
        <span class="min-w-0 flex-1 truncate font-mono text-[length:var(--ui-text-d3)]">{{
          file.path
        }}</span>
        <span class="flex-shrink-0 font-mono text-[length:var(--ui-text-d4)] tabular-nums">
          <span class="text-emerald-500">+{{ file.stats.additions }}</span>
          <span class="ml-1.5 text-red-500">-{{ file.stats.deletions }}</span>
        </span>
      </button>

      <!-- 卡片体：展开时渲染 diff -->
      <div v-if="isExpanded(file.path)" class="border-t border-border/60 bg-card/40 px-3 py-2">
        <DiffView
          v-if="file.diff"
          :edit="toolEditFor(file)"
          :mode="uiStore.reviewDiffMode"
          :key="file.path + uiStore.reviewDiffMode"
        />
        <!-- 有统计但无行级 diff（二进制/超大文件/流式未完成） -->
        <div v-else class="py-4 text-center text-[length:var(--ui-text-d3)] text-muted-foreground">
          此文件无行级差异 ·
          <span class="text-emerald-500">+{{ file.stats.additions }}</span>
          <span class="ml-1.5 text-red-500">-{{ file.stats.deletions }}</span>
        </div>
      </div>
    </div>

    <!-- 空态 -->
    <div
      v-if="uiStore.reviewFiles.length === 0"
      class="flex h-full flex-col items-center justify-center gap-2 py-12 text-[length:var(--ui-text-base)] text-muted-foreground"
    >
      <FileDiffIcon class="h-8 w-8 opacity-40" />
      <p>暂无变更文件</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import DiffView from '@renderer/components/chat/tools/DiffView.vue'
import { useUiStore } from '@renderer/stores/ui'
import type { CodexFileChange } from '@shared/backend/blocks'
import type { ToolEditInfo } from '@shared/backend/types'
import { ChevronRightIcon, FileDiffIcon } from 'lucide-vue-next'
import { nextTick, ref, watch } from 'vue'

import FileTypeIcon from './FileTypeIcon.vue'

const uiStore = useUiStore()

/** 卡片 DOM 引用，用于 focusPath 时滚动定位 */
const cardRefs = ref<HTMLElement[]>([])

function isExpanded(path: string): boolean {
  return uiStore.reviewExpandedPaths.has(path)
}

function onToggle(path: string): void {
  uiStore.setReviewSelectedPath(path)
  uiStore.toggleReviewFileExpanded(path)
}

/** CodexFileChange → ToolEditInfo（DiffView 的 unified_diff 分支） */
function toolEditFor(change: CodexFileChange): ToolEditInfo {
  return { type: 'unified_diff', filePath: change.path, diff: change.diff ?? '' }
}

function fileName(path: string): string {
  const clean = path.replace(/[/\\]+$/, '')
  return clean.slice(Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\')) + 1)
}

// 选中的 focusPath 变化时，滚动对应卡片到视口（从 CodexChangesCard 点文件进入时触发）
watch(
  () => uiStore.reviewSelectedPath,
  async (path) => {
    if (!path) return
    await nextTick()
    const el = cardRefs.value.find((n) => n.dataset['path'] === path)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  },
)
</script>

<style scoped>
.review-diff-list {
  height: 100%;
  overflow-y: auto;
}
</style>
