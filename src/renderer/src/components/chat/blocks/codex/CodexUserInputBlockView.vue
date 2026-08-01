<template>
  <!--
    图片缩略图：imageSrc 由父组件（CodexUserMessage）统一解析，
    点击只 emit('preview')——由父组件收集同组所有图片后交给 Image Preview Overlay。
    这样多张图片能在 overlay 里左右切换。
  -->
  <button
    v-if="block.kind === 'image'"
    type="button"
    class="group relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-border bg-muted/50"
    :class="clickable ? 'cursor-pointer' : 'cursor-default'"
    :title="title"
    @click="onClickImage"
  >
    <img
      v-if="imageSrc && !imageFailed"
      :src="imageSrc"
      :alt="label"
      class="h-full w-full object-cover"
      @error="onError"
    />
    <span
      v-else
      class="flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-[length:var(--chat-text-d3)] text-muted-foreground"
    >
      <ImageIcon class="h-4 w-4" />
      <span class="w-full truncate">{{ imageLoading ? '加载中' : label }}</span>
    </span>
    <span
      v-if="imageSrc && !imageFailed"
      class="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/55 px-1.5 py-0.5 text-left text-[length:var(--chat-text-d3)] text-white opacity-0 transition-opacity group-hover:opacity-100"
    >
      {{ label }}
    </span>
  </button>

  <button
    v-else
    type="button"
    class="inline-flex max-w-[280px] items-center gap-1.5 rounded-md border border-border/70 bg-muted/60 px-2 py-1 text-[length:var(--chat-text-d1)] text-muted-foreground transition-colors"
    :class="clickable ? 'cursor-pointer hover:text-foreground' : 'cursor-default'"
    :title="title"
    @click="openInput"
  >
    <SparklesIcon v-if="block.kind === 'skill'" class="h-3.5 w-3.5 shrink-0" />
    <AtSignIcon v-else-if="block.kind === 'mention'" class="h-3.5 w-3.5 shrink-0" />
    <FileIcon v-else class="h-3.5 w-3.5 shrink-0" />
    <span class="truncate">{{ label }}</span>
  </button>
</template>

<script setup lang="ts">
import { useFilesStore } from '@renderer/stores/files'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type { CodexUserInputContentBlock } from '@shared/backend/blocks'
import { AtSignIcon, FileIcon, ImageIcon, SparklesIcon } from 'lucide-vue-next'
import { computed } from 'vue'

const props = defineProps<{
  block: CodexUserInputContentBlock
  /** 父组件解析好的图片展示源（data:URL / https URL）。仅 image kind 用 */
  imageSrc?: string | null
  /** 图片是否正在解析（仅本地 path 图片会有 loading 态） */
  imageLoading?: boolean
  /** 图片解析失败标记 */
  imageFailed?: boolean
}>()

const emit = defineEmits<{
  /** 图片被点击：父组件收集整组后打开 Image Preview Overlay */
  preview: []
}>()

const filesStore = useFilesStore()
const workspaceStore = useWorkspaceStore()

const label = computed(() => props.block.name || fileName(props.block.path) || '图片')
const title = computed(() => props.block.path ?? props.block.url ?? label.value)
const clickable = computed(
  () =>
    Boolean(props.block.path) ||
    Boolean(props.block.url?.startsWith('https://') || props.block.url?.startsWith('http://')),
)

function onClickImage(): void {
  // 图片优先走预览 overlay（父组件负责收集整组）；无可展示源时退回打开引用
  if (props.imageSrc || props.block.url) {
    emit('preview')
    return
  }
  void openInput()
}

function onError(): void {
  // 触发父组件标记失败由父组件统一重试；这里仅做兜底，避免空事件
}

async function openInput(): Promise<void> {
  const workspaceId = workspaceStore.currentWorkspace?.id
  if (props.block.path && workspaceId) {
    await filesStore.openFileReference(workspaceId, props.block.path)
    return
  }
  if (props.block.url?.startsWith('https://') || props.block.url?.startsWith('http://')) {
    await window.api.system.openExternal({ url: props.block.url })
  }
}

function fileName(path?: string): string {
  if (!path) return ''
  const clean = path.replace(/[/\\]+$/, '')
  return clean.slice(Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\')) + 1)
}
</script>
