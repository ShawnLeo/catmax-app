<template>
  <div class="relative">
    <div
      ref="scrollerRef"
      class="generated-image-strip flex gap-2 overflow-x-auto pb-2"
      @scroll.passive="updateScrollState"
    >
      <div
        v-for="(block, blockIndex) in blocks"
        :key="block.id"
        class="generated-image-tile relative shrink-0 overflow-hidden rounded-xl border border-border/70 bg-muted/20"
      >
        <button
          v-if="imageSrcMap[block.id]"
          type="button"
          class="group block aspect-square w-full overflow-hidden text-left"
          :title="`预览 ${fileName(block.path) || '生成图片'}`"
          @click="openPreview(blockIndex)"
        >
          <img
            :src="imageSrcMap[block.id]"
            :alt="fileName(block.path) || '生成图片'"
            class="size-full object-cover transition-transform duration-200 group-hover:scale-[1.015]"
          />
        </button>
        <div
          v-else
          class="flex aspect-square items-center justify-center px-2 text-center text-[length:var(--chat-text-d2)] text-muted-foreground"
        >
          {{ failedIds.has(block.id) ? '图片加载失败' : '正在加载图片…' }}
        </div>
      </div>
    </div>

    <!-- Image Gallery Scrolling: 控件悬浮在视口右下角，每次平滑移动一张。 -->
    <div
      v-if="blocks.length > PAGE_SIZE"
      class="absolute right-1.5 bottom-3 flex items-center gap-1 rounded-full bg-background/80 p-1 text-foreground shadow-sm backdrop-blur-md"
    >
      <button
        type="button"
        class="grid size-6 place-items-center rounded-full bg-foreground/10 transition-opacity hover:bg-foreground/20 disabled:cursor-default disabled:opacity-35"
        title="向左滚动"
        :disabled="!canScrollPrevious"
        @click="scrollPrevious"
      >
        <ChevronLeftIcon class="size-4" />
      </button>
      <button
        type="button"
        class="grid size-6 place-items-center rounded-full bg-foreground/10 transition-opacity hover:bg-foreground/20 disabled:cursor-default disabled:opacity-35"
        title="向右滚动"
        :disabled="!canScrollNext"
        @click="scrollNext"
      >
        <ChevronRightIcon class="size-4" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useImagePreviewStore, type PreviewImageItem } from '@renderer/stores/image-preview'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type { CodexGeneratedImageContentBlock } from '@shared/backend/blocks'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-vue-next'
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

const PAGE_SIZE = 4
const props = defineProps<{ blocks: CodexGeneratedImageContentBlock[] }>()
const previewStore = useImagePreviewStore()
const workspaceStore = useWorkspaceStore()
const imageSrcMap = reactive<Record<string, string>>({})
const failedIds = ref(new Set<string>())
const scrollerRef = ref<HTMLElement | null>(null)
const canScrollPrevious = ref(false)
const canScrollNext = ref(false)
let resizeObserver: ResizeObserver | null = null

watch(
  () => [props.blocks, workspaceStore.currentWorkspace?.id] as const,
  async ([blocks, workspaceId]) => {
    failedIds.value = new Set()
    await Promise.all(
      blocks.map(async (block) => {
        if (block.url) {
          imageSrcMap[block.id] = block.url
          return
        }
        if (!block.path || !workspaceId) return
        try {
          const preview = await window.api.fs.readFilePreview({
            workspaceId,
            relativePath: fileName(block.path) || block.path,
            absolutePath: block.path,
          })
          if (preview.kind === 'image' && preview.dataUrl) imageSrcMap[block.id] = preview.dataUrl
          else failedIds.value = new Set(failedIds.value).add(block.id)
        } catch {
          failedIds.value = new Set(failedIds.value).add(block.id)
        }
      }),
    )
    await nextTick()
    updateScrollState()
  },
  { immediate: true },
)

onMounted(() => {
  if (scrollerRef.value) {
    resizeObserver = new ResizeObserver(updateScrollState)
    resizeObserver.observe(scrollerRef.value)
  }
  updateScrollState()
})

onBeforeUnmount(() => resizeObserver?.disconnect())

function updateScrollState(): void {
  const scroller = scrollerRef.value
  if (!scroller) return
  canScrollPrevious.value = scroller.scrollLeft > 1
  canScrollNext.value = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1
}

function scrollPrevious(): void {
  scrollByTile(-1)
}

function scrollNext(): void {
  scrollByTile(1)
}

function scrollByTile(direction: -1 | 1): void {
  const scroller = scrollerRef.value
  const tile = scroller?.firstElementChild as HTMLElement | null
  if (!scroller || !tile) return
  const gap = Number.parseFloat(getComputedStyle(scroller).columnGap) || 0
  scroller.scrollBy({ left: direction * (tile.offsetWidth + gap), behavior: 'smooth' })
}

function openPreview(blockIndex: number): void {
  const items: PreviewImageItem[] = []
  let startIndex = 0
  props.blocks.forEach((block, index) => {
    const url = imageSrcMap[block.id]
    if (!url) return
    if (index < blockIndex) startIndex += 1
    const name = fileName(block.path)
    items.push(name ? { url, name } : { url })
  })
  previewStore.open(items, startIndex)
}

function fileName(path?: string): string {
  if (!path) return ''
  const clean = path.replace(/[/\\]+$/, '')
  return clean.slice(Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\')) + 1)
}
</script>

<style scoped>
.generated-image-strip {
  scroll-behavior: smooth;
  scroll-snap-type: x proximity;
}

.generated-image-strip::-webkit-scrollbar {
  height: 6px;
}

.generated-image-strip::-webkit-scrollbar-track {
  background: transparent;
}

.generated-image-strip::-webkit-scrollbar-thumb {
  border-radius: 9999px;
  background: color-mix(in oklch, var(--foreground) 22%, transparent);
}

.generated-image-strip::-webkit-scrollbar-thumb:hover {
  background: color-mix(in oklch, var(--foreground) 34%, transparent);
}

.generated-image-tile {
  /* 四张图片加三个 8px gap 恰好占满可视宽度。 */
  flex-basis: calc((100% - 1.5rem) / 4);
  scroll-snap-align: start;
}
</style>
