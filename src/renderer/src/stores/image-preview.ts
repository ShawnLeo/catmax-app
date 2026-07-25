import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * 一张可预览图片的最小描述。
 * `url` 是已就绪的展示源（data:URL / http(s) URL）——
 * 本地文件块在调用 open() 前已通过 readFilePreview 解析成 data:URL，
 * 这里不再关心来源差异，只做预览交互。
 */
export interface PreviewImageItem {
  url: string
  /** 下载时用的建议文件名 */
  name?: string
}

/**
 * Image Preview Overlay 的全局状态（单例 store）。
 *
 * 设计为「整应用一份」预览：任何位置的图片缩略图都能调 open() 把一组图片
 * + 起始索引交给 App.vue 挂载的 ImagePreviewOverlay 渲染。
 * store 只持有数据和当前索引，overlay 组件负责所有交互与布局。
 */
export const useImagePreviewStore = defineStore('imagePreview', () => {
  const images = ref<PreviewImageItem[]>([])
  const index = ref(0)
  const visible = ref(false)

  const current = computed(() =>
    visible.value && index.value >= 0 && index.value < images.value.length
      ? images.value[index.value]
      : null,
  )
  const total = computed(() => images.value.length)

  /** 打开预览。items 至少一张；startIndex 指定初始展示哪一张 */
  function open(items: PreviewImageItem[], startIndex = 0): void {
    if (!items.length) return
    images.value = items
    index.value = Math.min(Math.max(0, startIndex), items.length - 1)
    visible.value = true
  }

  function close(): void {
    visible.value = false
  }

  /** 切到下一张（循环到第一张） */
  function next(): void {
    if (total.value <= 1) return
    index.value = (index.value + 1) % total.value
  }

  /** 切到上一张（循环到最后一张） */
  function prev(): void {
    if (total.value <= 1) return
    index.value = (index.value - 1 + total.value) % total.value
  }

  function setIndex(i: number): void {
    if (i >= 0 && i < total.value) index.value = i
  }

  return {
    images,
    index,
    visible,
    current,
    total,
    open,
    close,
    next,
    prev,
    setIndex,
  }
})
