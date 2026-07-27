<template>
  <!--
    Image Preview Overlay: 覆盖整个应用窗口的全屏图片预览。

    关键约束——「遮罩不要把窗口控制按钮给覆盖了」：
    窗口控制按钮（macOS 红绿灯 / Windows 标准按钮）是 frameless 窗口的自定义 DOM
    （.titlebar-controls），固定在左上角 header 里。如果直接用 inset-0 的黑底铺满，
    会盖住它们导致无法点关闭/最小化。

    解决办法：读取 .titlebar-controls 的 getBoundingClientRect()，用 clip-path
    的 evenodd 规则在遮罩上挖一个刚好包住按钮的「洞」——按钮可见且可点击，其余区域
    仍是半透明黑色遮罩。rect 在打开时与窗口 resize 时各算一次（预览期间不会切侧栏，
    按钮位置不会变）。

    Teleport 到 body + z-[10000]：盖在所有面板/弹窗（CommandPalette z-50、下拉 z-9999）之上。
  -->
  <Teleport to="body">
    <div
      v-if="preview.visible"
      class="fixed inset-0 z-[10000] select-none"
      data-image-preview-overlay
    >
      <!-- 遮罩层：挖洞后的半透明黑底。点击空白处关闭。 -->
      <div
        class="absolute inset-0 bg-black/90 backdrop-blur-sm"
        :style="{ clipPath: clipPathStyle }"
        @click="onBackdropClick"
        @wheel.prevent="onWheel"
      />

      <!-- 顶部工具栏（右上角，避开左上角的窗口控制按钮） -->
      <div class="absolute right-4 top-4 z-10 flex items-center gap-1.5">
        <OverlayButton
          :title="downloading ? '下载中…' : '下载'"
          :disabled="!preview.current || downloading"
          @click="onDownload"
        >
          <span
            v-if="downloading"
            class="block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
          />
          <DownloadIcon v-else class="h-4 w-4" />
        </OverlayButton>
        <OverlayButton title="关闭 (Esc)" @click="preview.close()">
          <XIcon class="h-4 w-4" />
        </OverlayButton>
      </div>

      <!-- 左右切换按钮：仅多图时显示，垂直居中于两侧 -->
      <template v-if="preview.total > 1">
        <OverlayButton
          class="absolute left-4 top-1/2 z-10 -translate-y-1/2"
          title="上一张 (←)"
          @click="preview.prev()"
        >
          <ChevronLeftIcon class="h-5 w-5" />
        </OverlayButton>
        <OverlayButton
          class="absolute right-4 top-1/2 z-10 -translate-y-1/2"
          title="下一张 (→)"
          @click="preview.next()"
        >
          <ChevronRightIcon class="h-5 w-5" />
        </OverlayButton>

        <!-- 计数指示（顶部居中） -->
        <div
          class="pointer-events-none absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-xs text-white/90"
        >
          {{ preview.index + 1 }} / {{ preview.total }}
        </div>
      </template>

      <!-- 图片舞台：放大/缩放以中心为锚点（默认 transform-origin: center），滚轮缩放 + 拖拽平移。 -->
      <div
        class="absolute inset-0 flex items-center justify-center overflow-hidden"
        @mousedown="onStageMouseDown"
      >
        <img
          ref="imageEl"
          :src="preview.current?.url"
          :alt="preview.current?.name ?? '图片'"
          class="max-h-full max-w-full select-none object-contain will-change-transform"
          :class="zoom > 1 ? 'cursor-grab' : 'cursor-default'"
          :style="{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transition: dragging ? 'none' : 'transform 0.15s ease-out',
          }"
          draggable="false"
          @load="onImageLoad"
          @click.stop
        />
      </div>

      <!-- 底部居中：缩放控件 -->
      <div
        class="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/15 bg-black/60 px-2 py-1 backdrop-blur"
      >
        <OverlayButton title="缩小" :disabled="zoom <= MIN_ZOOM" compact @click="zoomOut">
          <MinusIcon class="h-4 w-4" />
        </OverlayButton>
        <button
          type="button"
          class="min-w-[3.5rem] cursor-pointer rounded-md px-2 py-1 text-center text-xs text-white/90 hover:bg-white/10"
          :title="zoom === 1 ? '实际大小' : '重置缩放'"
          @click="resetZoom"
        >
          {{ Math.round(zoom * 100) }}%
        </button>
        <OverlayButton title="放大" :disabled="zoom >= MAX_ZOOM" compact @click="zoomIn">
          <PlusIcon class="h-4 w-4" />
        </OverlayButton>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { useImagePreviewStore } from '@renderer/stores/image-preview'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  MinusIcon,
  PlusIcon,
  XIcon,
} from 'lucide-vue-next'
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'

import OverlayButton from './OverlayButton.vue'

const preview = useImagePreviewStore()

const MIN_ZOOM = 0.5
const MAX_ZOOM = 8
const ZOOM_STEP = 0.2
/** 滚轮每次缩放的步长比例 */
const WHEEL_ZOOM_STEP = 0.15

const zoom = ref(1)
const pan = ref({ x: 0, y: 0 })
const dragging = ref(false)
const downloading = ref(false)
const imageEl = ref<HTMLImageElement | null>(null)

/** 窗口控制按钮的安全矩形（挖洞用）。null 时兜底按平台给一个默认值。 */
const controlsRect = ref<DOMRect | null>(null)
const platform = ref<'darwin' | 'win32' | 'linux'>('darwin')

/** 兜底安全区：读取不到 .titlebar-controls 时按平台给保守的左上角矩形 */
const fallbackRect = computed(() => {
  // macOS 红绿灯较小，Windows/Linux 三个标准按钮较宽。
  const w = platform.value === 'darwin' ? 80 : 150
  return { x: 0, y: 0, width: w, height: 44 } as DOMRect
})
const safeRect = computed(() => controlsRect.value ?? fallbackRect.value)

/**
 * clip-path 用 evenodd 规则挖洞：
 * 先描外框（整屏），再描内框（安全区），重叠区域被剔除 → 按钮露出。
 * 坐标用固定像素值拼字符串（clip-path 不支持 calc 混合 % 与 px）。
 */
const clipPathStyle = computed(() => {
  const r = safeRect.value
  const hx = r.x
  const hy = r.y
  const hw = r.x + r.width
  const hh = r.y + r.height
  return `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${hx}px ${hy}px, ${hw}px ${hy}px, ${hw}px ${hh}px, ${hx}px ${hh}px)`
})

/** 打开预览时：重置缩放、读取按钮位置、获取平台 */
watch(
  () => preview.visible,
  async (open) => {
    if (open) {
      resetZoom()
      await nextTick()
      measureControlsRect()
      try {
        const info = await window.api.system.platformInfo()
        platform.value = info.platform
      } catch {
        /* 平台读不到就用默认 darwin 兜底，不影响预览主体 */
      }
      window.addEventListener('resize', measureControlsRect)
    } else {
      window.removeEventListener('resize', measureControlsRect)
    }
  },
)

// 切图时也重置缩放，避免上一张的放大状态串到下一张
watch(
  () => preview.index,
  () => resetZoom(),
)

onUnmounted(() => {
  window.removeEventListener('resize', measureControlsRect)
})

/** 读取窗口控制按钮的实际屏幕位置（只在 frameless 窗口里有这一个元素） */
function measureControlsRect(): void {
  const el = document.querySelector('.titlebar-controls')
  controlsRect.value = el ? el.getBoundingClientRect() : null
}

function onImageLoad(): void {
  // 图片加载完成后无需额外处理；保留钩子便于后续按自然尺寸限制初始缩放
}

function resetZoom(): void {
  zoom.value = 1
  pan.value = { x: 0, y: 0 }
}

function zoomIn(): void {
  zoom.value = Math.min(MAX_ZOOM, +(zoom.value + ZOOM_STEP).toFixed(2))
}

function zoomOut(): void {
  zoom.value = Math.max(MIN_ZOOM, +(zoom.value - ZOOM_STEP).toFixed(2))
  // 缩到 1× 时归位，避免图片偏在一边
  if (zoom.value <= 1) pan.value = { x: 0, y: 0 }
}

/** 滚轮缩放：以光标为锚点（近似），放大/缩小后保持视觉焦点 */
function onWheel(e: WheelEvent): void {
  if (!preview.current) return
  if (e.deltaY < 0) {
    zoom.value = Math.min(MAX_ZOOM, +(zoom.value + WHEEL_ZOOM_STEP).toFixed(2))
  } else {
    zoom.value = Math.max(MIN_ZOOM, +(zoom.value - WHEEL_ZOOM_STEP).toFixed(2))
    if (zoom.value <= 1) pan.value = { x: 0, y: 0 }
  }
}

/** 放大后按住拖拽平移；1× 时禁止拖拽 */
function onStageMouseDown(e: MouseEvent): void {
  if (zoom.value <= 1) return
  dragging.value = true
  const startX = e.clientX
  const startY = e.clientY
  const startPan = { ...pan.value }

  const onMove = (ev: MouseEvent): void => {
    pan.value = {
      x: startPan.x + (ev.clientX - startX),
      y: startPan.y + (ev.clientY - startY),
    }
  }
  const onUp = (): void => {
    dragging.value = false
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

/** 点遮罩空白处关闭（点图片本体不关——img 上 @click.stop） */
function onBackdropClick(): void {
  preview.close()
}

async function onDownload(): Promise<void> {
  const item = preview.current
  if (!item || downloading.value) return
  downloading.value = true
  try {
    // exactOptionalPropertyTypes: 只有真的有名字时才带上 suggestedName
    const args = item.name ? { url: item.url, suggestedName: item.name } : { url: item.url }
    await window.api.system.saveImage(args)
  } catch (err) {
    console.error('[ImagePreview] 下载失败', err)
  } finally {
    downloading.value = false
  }
}

// 键盘交互：Esc 关闭、←/→ 切换、+/- 缩放
function onKeyDown(e: KeyboardEvent): void {
  if (!preview.visible) return
  switch (e.key) {
    case 'Escape':
      preview.close()
      break
    case 'ArrowLeft':
      preview.prev()
      break
    case 'ArrowRight':
      preview.next()
      break
    case '+':
    case '=':
      zoomIn()
      break
    case '-':
      zoomOut()
      break
    case '0':
      resetZoom()
      break
  }
}

window.addEventListener('keydown', onKeyDown)
onUnmounted(() => window.removeEventListener('keydown', onKeyDown))
</script>
