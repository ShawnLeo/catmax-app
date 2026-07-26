<template>
  <!--
    Review Panel: 审查 tab 主体。

    布局：[可关闭的文件树] [可拖动分隔条] [diff 列表区]
    - 文件树可拖宽（ResizeHandle side="left"）、可关闭（关闭后列表占满，工具条出现「显示树」按钮）
    - diff 列表区顶部：统一/拆分切换 + 文件树显隐按钮
    - 列表区主体：ReviewDiffList（所有变更文件的可折叠卡片）
  -->
  <div class="flex h-full min-w-0">
    <!-- 左：变更文件树（可关闭） -->
    <div
      v-if="uiStore.reviewTreeVisible"
      class="shrink-0 border-r border-border"
      :style="{ width: uiStore.reviewTreeWidth + 'px' }"
    >
      <ReviewFileTree
        :files="uiStore.reviewFiles"
        :selected-path="uiStore.reviewSelectedPath"
        @select="onTreeSelect"
      />
    </div>

    <!-- 可拖动分隔条（树可见时才有） -->
    <ResizeHandle
      v-if="uiStore.reviewTreeVisible"
      side="left"
      :min="REVIEW_TREE_MIN"
      :max="REVIEW_TREE_MAX"
      :current="uiStore.reviewTreeWidth"
      @resize="uiStore.setReviewTreeWidth"
    />

    <!-- 右：diff 列表区 -->
    <div class="flex min-w-0 flex-1 flex-col">
      <!-- 顶部工具条 -->
      <div class="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <!-- 文件树显隐切换 -->
        <button
          type="button"
          :class="[
            'grid h-7 w-7 place-items-center rounded-md transition-colors',
            uiStore.reviewTreeVisible
              ? 'text-foreground hover:bg-muted'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          ]"
          :title="uiStore.reviewTreeVisible ? '隐藏文件树' : '显示文件树'"
          @click="uiStore.setReviewTreeVisible(!uiStore.reviewTreeVisible)"
        >
          <PanelLeftIcon class="h-4 w-4" />
        </button>

        <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {{ uiStore.reviewFiles.length }} 个文件变更 ·
          <span class="font-mono tabular-nums">
            <span class="text-emerald-500">+{{ uiStore.reviewStats.additions }}</span>
            <span class="ml-1 text-red-500">-{{ uiStore.reviewStats.deletions }}</span>
          </span>
        </span>

        <!-- 全部展开/收起：有文件展开时显示「收起」，否则「展开」 -->
        <button
          v-if="uiStore.reviewFiles.length > 0"
          type="button"
          class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          :title="allExpanded ? '全部收起' : '全部展开'"
          @click="allExpanded ? uiStore.collapseAllReviewFiles() : uiStore.expandAllReviewFiles()"
        >
          <ChevronsDownUpIcon v-if="allExpanded" class="h-4 w-4" />
          <ChevronsUpDownIcon v-else class="h-4 w-4" />
        </button>

        <!-- 统一/拆分 切换按钮组 -->
        <div class="flex items-center overflow-hidden rounded-md border border-border">
          <button
            type="button"
            :class="[
              'h-7 px-2.5 text-xs transition-colors',
              uiStore.reviewDiffMode === 'unified'
                ? 'bg-primary/10 text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            ]"
            title="统一视图（单列 +/- 穿插）"
            @click="uiStore.setReviewDiffMode('unified')"
          >
            统一
          </button>
          <button
            type="button"
            :class="[
              'h-7 px-2.5 text-xs transition-colors',
              uiStore.reviewDiffMode === 'split'
                ? 'bg-primary/10 text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            ]"
            title="拆分视图（左右双列）"
            @click="uiStore.setReviewDiffMode('split')"
          >
            拆分
          </button>
        </div>
      </div>

      <!-- 列表主体 -->
      <div class="min-h-0 flex-1 overflow-hidden">
        <ReviewDiffList />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import ResizeHandle from '@renderer/components/ui/ResizeHandle.vue'
import { useUiStore } from '@renderer/stores/ui'
import { ChevronsDownUpIcon, ChevronsUpDownIcon, PanelLeftIcon } from 'lucide-vue-next'
import { computed } from 'vue'

import ReviewDiffList from './ReviewDiffList.vue'
import ReviewFileTree from './ReviewFileTree.vue'

const uiStore = useUiStore()

const REVIEW_TREE_MIN = 160
const REVIEW_TREE_MAX = 480

/** 是否所有文件都已展开（决定按钮显示「全部收起」还是「全部展开」） */
const allExpanded = computed(
  () =>
    uiStore.reviewFiles.length > 0 &&
    uiStore.reviewExpandedPaths.size >= uiStore.reviewFiles.length,
)

/** 树点击文件：选中 + 自动展开对应卡片（与列表联动） */
function onTreeSelect(path: string): void {
  uiStore.setReviewSelectedPath(path)
  uiStore.setReviewFileExpanded(path, true)
}
</script>
