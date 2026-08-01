<template>
  <button
    v-if="imageSrc"
    type="button"
    class="group relative min-w-0 overflow-hidden rounded-xl border border-border/70 bg-muted/20 text-left"
    :title="name ? `预览 ${name}` : '预览生成图片'"
    @click="openPreview"
  >
    <img
      :src="imageSrc"
      :alt="name || '生成图片'"
      class="block max-h-[28rem] w-full object-contain transition-transform duration-200 group-hover:scale-[1.01]"
    />
    <span
      v-if="name"
      class="absolute inset-x-0 bottom-0 truncate bg-background/80 px-2.5 py-1.5 text-[length:var(--chat-text-d2)] text-muted-foreground backdrop-blur-sm"
    >
      {{ name }}
    </span>
  </button>
  <div
    v-else
    class="flex min-h-28 items-center justify-center rounded-xl border border-border/70 bg-muted/20 text-[length:var(--chat-text-d2)] text-muted-foreground"
  >
    {{ failed ? '图片加载失败' : '正在加载图片…' }}
  </div>
</template>

<script setup lang="ts">
import { useImagePreviewStore } from '@renderer/stores/image-preview'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type { CodexGeneratedImageContentBlock } from '@shared/backend/blocks'
import { computed, ref, watch } from 'vue'

const props = defineProps<{ block: CodexGeneratedImageContentBlock }>()
const previewStore = useImagePreviewStore()
const workspaceStore = useWorkspaceStore()
const imageSrc = ref(props.block.url ?? '')
const failed = ref(false)

const name = computed(() => {
  if (!props.block.path) return ''
  const clean = props.block.path.replace(/[/\\]+$/, '')
  return clean.slice(Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\')) + 1)
})

watch(
  () => [props.block.path, props.block.url, workspaceStore.currentWorkspace?.id] as const,
  async ([path, url, workspaceId]) => {
    imageSrc.value = url ?? ''
    failed.value = false
    if (imageSrc.value || !path || !workspaceId) return
    try {
      const preview = await window.api.fs.readFilePreview({
        workspaceId,
        relativePath: name.value || path,
        absolutePath: path,
      })
      if (preview.kind === 'image' && preview.dataUrl) imageSrc.value = preview.dataUrl
      else failed.value = true
    } catch {
      failed.value = true
    }
  },
  { immediate: true },
)

function openPreview(): void {
  if (!imageSrc.value) return
  previewStore.open(
    [name.value ? { url: imageSrc.value, name: name.value } : { url: imageSrc.value }],
    0,
  )
}
</script>
