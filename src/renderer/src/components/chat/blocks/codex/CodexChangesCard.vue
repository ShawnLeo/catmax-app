<template>
  <div class="mt-5 overflow-hidden rounded-xl border border-border/70 bg-muted/20">
    <div class="flex items-center gap-2 px-3 py-2.5 text-[13px]">
      <FileDiffIcon class="size-4 text-muted-foreground" />
      <span>已编辑 {{ files.length }} 个文件</span>
      <span class="font-mono text-[12px] tabular-nums">
        <span class="text-emerald-500">+{{ stats.additions }}</span>
        <span class="ml-1 text-red-500">-{{ stats.deletions }}</span>
      </span>
      <div class="flex-1" />
      <button
        type="button"
        class="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
        @click="review"
      >
        审核
      </button>
      <button
        type="button"
        class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        :aria-label="open ? '收起文件' : '展开文件'"
        @click="open = !open"
      >
        <ChevronDownIcon class="size-4 transition-transform" :class="open ? 'rotate-180' : ''" />
      </button>
    </div>
    <div v-if="open" class="border-t border-border/60">
      <button
        v-for="file in files"
        :key="file.path"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-muted/40"
        @click="openFile(file.path)"
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
import { useFilesStore } from '@renderer/stores/files'
import { useUiStore } from '@renderer/stores/ui'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type { CodexDiffStats, CodexFileChange } from '@shared/backend/blocks'
import { ChevronDownIcon, FileDiffIcon } from 'lucide-vue-next'
import { ref } from 'vue'

defineProps<{ files: CodexFileChange[]; stats: CodexDiffStats }>()

const open = ref(false)
const filesStore = useFilesStore()
const uiStore = useUiStore()
const workspaceStore = useWorkspaceStore()

function review(): void {
  uiStore.showRightPanel('git')
}

async function openFile(path: string): Promise<void> {
  const workspaceId = workspaceStore.currentWorkspace?.id
  if (!workspaceId) return
  await filesStore.openFileReference(workspaceId, path)
}
</script>
