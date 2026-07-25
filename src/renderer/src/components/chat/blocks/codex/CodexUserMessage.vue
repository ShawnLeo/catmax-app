<template>
  <div class="flex justify-end">
    <div class="flex max-w-[80%] flex-col items-end gap-2 break-words">
      <div v-if="imageInputs.length" class="flex max-w-full justify-end gap-2 overflow-x-auto">
        <!--
          Image Preview Overlay: 每个图片缩略图带上自己在同级里的索引。
          点击时父组件把「这一组所有图片」交给 image-preview store，
          overlay 就能左右切换整组的图片。
        -->
        <CodexUserInputBlockView
          v-for="(block, idx) in imageInputs"
          :key="block.id"
          :block="block"
          :image-src="imageSrcMap[block.id] ?? null"
          :image-loading="imageLoadingSet.has(block.id)"
          :image-failed="imageFailedSet.has(block.id)"
          @preview="openImagePreview(idx)"
        />
      </div>

      <div v-if="referenceInputs.length" class="flex flex-wrap justify-end gap-1.5">
        <CodexUserInputBlockView v-for="block in referenceInputs" :key="block.id" :block="block" />
      </div>

      <div
        v-if="contextBlocks.length || textBlocks.length"
        class="flex max-w-full flex-col gap-2 rounded-2xl border border-border/50 bg-user-bubble px-3 py-2.5"
      >
        <div v-if="contextBlocks.length" class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <component
            :is="getBlockRenderer(block.type)"
            v-for="block in contextBlocks"
            :key="block.id"
            :block="block"
          />
        </div>
        <div
          v-for="block in textBlocks"
          :key="block.id"
          class="whitespace-pre-wrap text-[15px] leading-relaxed"
        >
          {{ block.text }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useImagePreviewStore, type PreviewImageItem } from '@renderer/stores/image-preview'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type {
  CodexUserInputContentBlock,
  ContextContentBlock,
  TextContentBlock,
} from '@shared/backend/blocks'
import { messageBlocks } from '@shared/backend/normalize-blocks'
import type { NormalizedMessage } from '@shared/backend/types'
import { computed, reactive, ref, watch } from 'vue'

import { getBlockRenderer } from '../registry'

import CodexUserInputBlockView from './CodexUserInputBlockView.vue'

const props = defineProps<{ message: NormalizedMessage }>()
const blocks = computed(() => messageBlocks(props.message))
const contextBlocks = computed(() =>
  blocks.value.filter((block): block is ContextContentBlock => block.type === 'context'),
)
const textBlocks = computed(() =>
  blocks.value.filter((block): block is TextContentBlock => block.type === 'text'),
)
const userInputs = computed(() =>
  blocks.value.filter(
    (block): block is CodexUserInputContentBlock => block.type === 'codex_user_input',
  ),
)
const imageInputs = computed(() => userInputs.value.filter((block) => block.kind === 'image'))
const referenceInputs = computed(() => userInputs.value.filter((block) => block.kind !== 'image'))

const workspaceStore = useWorkspaceStore()
const previewStore = useImagePreviewStore()

/**
 * 本组图片的「已就绪展示源」：block.id → url。
 * Image Preview Overlay 需要一次性拿到整组图片才能左右切换，
 * 所以把 readFilePreview 的解析从子组件上提到这里统一管理：
 * 有 url 直接用（data:URL / https URL），只有 path 的走 readFilePreview 转 data URL。
 */
const imageSrcMap = reactive<Record<string, string>>({})
const imageLoadingSet = ref<Set<string>>(new Set())
const imageFailedSet = ref<Set<string>>(new Set())

watch(
  () => [imageInputs.value, workspaceStore.currentWorkspace?.id] as const,
  async ([images, workspaceId]) => {
    // 清掉旧值，避免上一条消息的图片串进来
    imageInputs.value.forEach((b) => {
      delete imageSrcMap[b.id]
    })
    imageLoadingSet.value = new Set()
    imageFailedSet.value = new Set()

    await Promise.all(
      images.map(async (block) => {
        // 优先用 block 自带的 url（历史 rollout 里的 data URL / https URL）
        if (block.url) {
          imageSrcMap[block.id] = block.url
          return
        }
        // 只有 path 的本地图片：readFilePreview → data URL
        if (!block.path || !workspaceId) return
        imageLoadingSet.value = new Set(imageLoadingSet.value).add(block.id)
        try {
          const preview = await window.api.fs.readFilePreview({
            workspaceId,
            relativePath: fileName(block.path) || block.path,
            absolutePath: block.path,
          })
          if (preview.kind === 'image' && preview.dataUrl) imageSrcMap[block.id] = preview.dataUrl
        } catch {
          imageFailedSet.value = new Set(imageFailedSet.value).add(block.id)
        } finally {
          const next = new Set(imageLoadingSet.value)
          next.delete(block.id)
          imageLoadingSet.value = next
        }
      }),
    )
  },
  { immediate: true },
)

/** 点击某张图片：把整组 + 当前索引交给 preview store */
function openImagePreview(index: number): void {
  const items: PreviewImageItem[] = []
  for (const block of imageInputs.value) {
    const url = imageSrcMap[block.id]
    if (!url) continue
    const name = block.name || fileName(block.path)
    items.push(name ? { url, name } : { url })
  }
  if (!items.length) return
  previewStore.open(items, index)
}

function fileName(path?: string): string {
  if (!path) return ''
  const clean = path.replace(/[/\\]+$/, '')
  return clean.slice(Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\')) + 1)
}
</script>
