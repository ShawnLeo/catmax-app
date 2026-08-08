<template>
  <div
    :class="[
      'relative shrink-0 bg-panel-divider group',
      side === 'bottom' ? 'h-px w-full cursor-row-resize' : 'w-px cursor-col-resize',
    ]"
    @pointerdown="onPointerDown"
  >
    <!-- 扩大点击热区 -->
    <div
      :class="
        side === 'bottom'
          ? 'absolute inset-x-0 -top-1 -bottom-1 z-10'
          : 'absolute inset-y-0 -left-1 -right-1 z-10'
      "
    />
    <div
      :class="[
        'bg-transparent group-hover:bg-primary/40 transition-colors pointer-events-none',
        side === 'bottom' ? 'absolute inset-x-0 top-0 h-px' : 'absolute inset-y-0 left-0 w-px',
      ]"
    />
  </div>
</template>

<script setup lang="ts">
import { useUiStore } from '@renderer/stores/ui'

interface Props {
  side: 'left' | 'right' | 'bottom'
  min: number
  max: number
  current: number
}

const props = defineProps<Props>()
const emit = defineEmits<{
  resize: [size: number]
  reachMin: []
  reachMax: []
}>()
const uiStore = useUiStore()

function onPointerDown(e: PointerEvent): void {
  e.preventDefault()
  const target = e.currentTarget as HTMLElement
  target.setPointerCapture(e.pointerId)
  document.body.style.userSelect = 'none'
  // 通知 store 进入拖拽：面板关掉 transition，拖拽结束才统一持久化一次
  uiStore.startPanelDrag()

  if (props.side === 'bottom') {
    // 垂直拖拽：向上拖增大高度（delta 负 → 高度增大）
    const startY = e.clientY
    const startHeight = props.current
    document.body.style.cursor = 'row-resize'

    const onMove = (ev: PointerEvent): void => {
      const delta = startY - ev.clientY
      const next = startHeight + delta
      const clamped = Math.min(props.max, Math.max(props.min, next))
      emit('resize', clamped)
    }
    const onUp = (ev: PointerEvent): void => {
      target.releasePointerCapture(ev.pointerId)
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      uiStore.endPanelDrag()
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    return
  }

  // 水平拖拽（left / right）
  const startX = e.clientX
  const startWidth = props.current
  document.body.style.cursor = 'col-resize'

  const onMove = (ev: PointerEvent): void => {
    const delta = ev.clientX - startX
    const next = props.side === 'left' ? startWidth + delta : startWidth - delta
    const clamped = Math.min(props.max, Math.max(props.min, next))
    emit('resize', clamped)
  }
  const onUp = (ev: PointerEvent): void => {
    const delta = ev.clientX - startX
    const next = props.side === 'left' ? startWidth + delta : startWidth - delta
    target.releasePointerCapture(ev.pointerId)
    document.removeEventListener('pointermove', onMove)
    document.removeEventListener('pointerup', onUp)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    uiStore.endPanelDrag()
    if (next <= props.min) emit('reachMin')
    else if (next >= props.max) emit('reachMax')
  }
  document.addEventListener('pointermove', onMove)
  document.addEventListener('pointerup', onUp)
}
</script>
