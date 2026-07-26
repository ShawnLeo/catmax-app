<template>
  <div class="mt-5 overflow-hidden rounded-xl border border-border/70 bg-muted/20">
    <!--
      标题行整行可点击展开/收起（cursor-pointer + @click toggle），
      不再要求用户精准点到右侧箭头。审核按钮用 @click.stop 阻断冒泡，
      避免点审核时顺带触发收起。
    -->
    <div
      class="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-[13px]"
      role="button"
      :aria-expanded="open"
      :aria-label="open ? '收起文件列表' : '展开文件列表'"
      @click="open = !open"
    >
      <FileDiffIcon class="size-4 text-muted-foreground" />
      <span>已编辑 {{ files.length }} 个文件</span>
      <span class="font-mono text-[12px] tabular-nums">
        <span class="text-emerald-500">+{{ stats.additions }}</span>
        <span class="ml-1 text-red-500">-{{ stats.deletions }}</span>
      </span>
      <div class="flex-1" />
      <button
        type="button"
        class="cursor-pointer rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
        @click.stop="review"
      >
        审核
      </button>
      <!-- 纯视觉指示：整行已承担点击，箭头不再单独绑定事件 -->
      <ChevronDownIcon
        class="size-4 text-muted-foreground transition-transform"
        :class="open ? 'rotate-180' : ''"
      />
    </div>
    <div v-if="open" class="border-t border-border/60">
      <!--
        文件列表点击：进入审查 tab 并聚焦该文件（不是打开编辑器）。
        showReview 的 focusPath 会让审查面板自动展开 + 滚动到这个文件的 diff 卡片。
      -->
      <button
        v-for="file in files"
        :key="file.path"
        type="button"
        class="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-muted/40"
        @click="reviewFile(file.path)"
      >
        <span class="min-w-0 flex-1 truncate font-mono">{{ file.path }}</span>
        <span class="font-mono tabular-nums">
          <span class="text-emerald-500">+{{ file.stats.additions }}</span>
          <span class="ml-1 text-red-500">-{{ file.stats.deletions }}</span>
        </span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useUiStore } from '@renderer/stores/ui'
import type { CodexDiffStats, CodexFileChange } from '@shared/backend/blocks'
import { ChevronDownIcon, FileDiffIcon } from 'lucide-vue-next'
import { ref } from 'vue'

const props = defineProps<{ files: CodexFileChange[]; stats: CodexDiffStats }>()

const open = ref(false)
const uiStore = useUiStore()

/** 整体审查：进入审查 tab，默认展开第一个有 diff 的文件 */
function review(): void {
  uiStore.showReview(props.files, props.stats)
}

/** 点具体文件：进入审查并聚焦该文件（自动展开 + 滚动定位） */
function reviewFile(path: string): void {
  uiStore.showReview(props.files, props.stats, path)
}
</script>
