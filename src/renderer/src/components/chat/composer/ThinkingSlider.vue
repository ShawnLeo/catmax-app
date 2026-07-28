<template>
  <!--
    思考强度控件——trigger 按钮 + 弹出圆点轨道。

    跟 DropdownMenu 视觉/交互模式对齐（placement=top 向上展开），
    但弹层内容是圆点轨道而非选项列表。

    折叠态：脑图标 + 当前档位 label + chevron。点击展开弹层。
    弹层：横向 N 个圆点（'none' 永远在最前），当前档位实心填充：
      - 选中档：实心 foreground 色
      - 左侧已"经过"档：中灰
      - 右侧未到达档：暗灰
      - max 选中：紫色填充 + 脉冲 + 稍大

    两种交互（跟原生 slider 一致）：
      - 单击圆点：切到该档
      - 按住鼠标拖拽：跟随光标所在圆点实时切档（pointer events，
        兼容鼠标和触摸屏）

    'none' = 关闭思考（codex 零 reasoning token；claude 压到 low）。
  -->
  <div ref="rootEl" class="relative inline-block">
    <!-- 折叠态触发按钮（跟 DropdownMenu trigger 同款样式）。
         加 effort-trigger-btn class 让外部样式能精确选中此 trigger,
         不影响弹层内的圆点 button(:deep(button > span) 会误伤圆点)。 -->
    <button
      type="button"
      :title="triggerTitle"
      class="effort-trigger-btn flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-pointer"
      @click="open = !open"
    >
      <BrainIcon
        class="w-4 h-4 flex-shrink-0"
        :class="
          modelValue === 'none'
            ? 'text-muted-foreground/50'
            : isMax
              ? 'text-brain'
              : 'text-foreground'
        "
      />
      <span class="truncate">{{ tierLabel(modelValue) }}</span>
      <ChevronDownIcon
        class="w-4 h-4 flex-shrink-0 transition-transform"
        :class="open ? 'rotate-180' : ''"
      />
    </button>

    <!-- 弹出圆点轨道（placement=top 向上展开，避开窗口底部遮挡） -->
    <div
      v-if="open"
      class="absolute bottom-full mb-1 left-0 z-50 rounded-md border border-border bg-popover p-2 shadow-lg"
    >
      <div ref="trackEl" class="flex items-center gap-2 select-none" @pointerdown="onPointerDown">
        <button
          v-for="level in levels"
          :key="level"
          ref="dotRefs"
          type="button"
          class="p-1 transition-all duration-150 cursor-pointer"
          :class="level === 'max' && isMax ? 'animate-pulse' : ''"
          :title="tierTitle(level)"
          @click="onDotClick(level)"
        >
          <span
            class="block rounded-full transition-all duration-150"
            :class="[level === 'max' && isMax ? 'w-2.5 h-2.5' : 'w-2 h-2', dotFillClass(level)]"
          />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { EffortLevel } from '@shared/backend/types'
import { BrainIcon, ChevronDownIcon } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{
  /** 当前 effort 值（双向绑定，v-model） */
  modelValue: EffortLevel
  /** 该后端实际支持的档位（来自 capabilities.supportedEfforts） */
  supported: EffortLevel[]
}>()
const emit = defineEmits<{
  'update:modelValue': [value: EffortLevel]
}>()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)
const trackEl = ref<HTMLElement | null>(null)
/** 圆点 button 数组——拖拽时用 elementFromPoint 反查光标下的圆点 */
const dotRefs = ref<HTMLElement[]>([])

/** 是否处于拖拽中——拖拽中不响应 click（避免 pointerup 后又触发 click 重复切档） */
const dragging = ref(false)

const isMax = computed(() => props.modelValue === 'max')

/**
 * 实际渲染的档位列表——capabilities.supportedEfforts 前面补一个虚拟 'none' 档。
 * 'none' 永远在最前（表示"关闭思考"），即使后端 capabilities 没声明也显示。
 * 同时过滤掉 supported 里可能误带的 'none'（避免重复）。
 */
const levels = computed<EffortLevel[]>(() => {
  const filtered = props.supported.filter((l) => l !== 'none')
  return ['none', ...filtered]
})

const triggerTitle = computed(() => {
  if (props.modelValue === 'none') return '思考：关（点击调节）'
  if (isMax.value) return '思考：极致性能（点击调节）'
  return `思考：${tierLabel(props.modelValue)}（点击调节）`
})

/**
 * 圆点填充样式——四态：
 *   - 当前选中（非 max）：实心 foreground 色（视觉最亮）
 *   - 当前选中 = max：实心 brain 紫色 + 紫色光晕（极致性能视觉信号）
 *   - 未选中但位置 < 当前档（轨道左侧已"经过"）：中灰
 *   - 未选中且位置 > 当前档（轨道右侧未到达）：暗灰
 */
function dotFillClass(level: EffortLevel): string {
  const currentIdx = levels.value.indexOf(props.modelValue)
  const thisIdx = levels.value.indexOf(level)
  const selected = level === props.modelValue

  if (selected) {
    if (level === 'max') {
      return 'bg-brain shadow-[0_0_8px_rgba(168,85,247,0.7)]'
    }
    return 'bg-foreground'
  }
  if (thisIdx < currentIdx) {
    return 'bg-muted-foreground/70'
  }
  return 'bg-muted-foreground/30'
}

/** 档位 → UI 文案（用于 trigger 按钮显示和 tooltip）。
 *  与设置面板 BackendSection.vue 的 effortLabel 保持一致：关闭/低/中/高/超高/最高。 */
function tierLabel(level: EffortLevel): string {
  switch (level) {
    case 'none':
      return '关闭'
    case 'low':
      return '低'
    case 'medium':
      return '中'
    case 'high':
      return '高'
    case 'xhigh':
      return '超高'
    case 'max':
      return '最高'
  }
}

/** 档位 → tooltip 说明 */
function tierTitle(level: EffortLevel): string {
  switch (level) {
    case 'none':
      return '关闭思考（codex 零 reasoning token；claude 压到 low）'
    case 'low':
      return '低强度'
    case 'medium':
      return '中等强度'
    case 'high':
      return '高强度（推荐通用）'
    case 'xhigh':
      return '超高强度（推荐编码）'
    case 'max':
      return '极致性能（消耗最多 token）'
  }
}

function select(level: EffortLevel): void {
  if (level !== props.modelValue) {
    emit('update:modelValue', level)
  }
}

/** 单击圆点切档——拖拽中不响应（pointerup 后浏览器会补发一次 click） */
function onDotClick(level: EffortLevel): void {
  if (dragging.value) return
  select(level)
}

/**
 * clickOutside 收起弹层——点弹层外任意位置时关闭。
 * 跟 DropdownMenu 的实现一致（capture 阶段抓事件）。
 */
function handleOutsideClick(e: MouseEvent): void {
  if (!open.value) return
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) {
    open.value = false
  }
}

/**
 * 拖拽起点：pointerdown 时立刻选中当前光标下的圆点，并挂上全局 pointermove/up 监听。
 * 用 Pointer Events 而非 Mouse Events——同时覆盖鼠标、触摸屏、触控笔。
 *
 * 实现思路（跟 input[type=range] 一致）：
 *   1. pointerdown → 立刻 select 光标下的圆点 + 标记 dragging
 *   2. pointermove（document 级）→ 用 elementFromPoint 找光标下的圆点，select
 *   3. pointerup（document 级）→ 清 dragging + 移除监听 + 防止后续 click
 */
function onPointerDown(e: PointerEvent): void {
  if (!trackEl.value) return
  // 阻止默认的 drag/选区行为（虽然 button 本身不会拖拽，但保险起见）
  e.preventDefault()

  dragging.value = true
  selectDotAtPoint(e.clientX, e.clientY)

  document.addEventListener('pointermove', onPointerMove)
  document.addEventListener('pointerup', onPointerUp)
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging.value) return
  selectDotAtPoint(e.clientX, e.clientY)
}

function onPointerUp(): void {
  dragging.value = false
  document.removeEventListener('pointermove', onPointerMove)
  document.removeEventListener('pointerup', onPointerUp)
}

/**
 * 用 elementFromPoint 反查光标位置对应的圆点 button，找到就 select 对应档位。
 * 圆点本身较小（2×2），pointermove 时光标可能落在 button 的 padding 区域——
 * elementFromPoint 会返回最顶层的元素，可能是 button 本身、里面的 span、或 button 间的 gap。
 * 用 closest('button') 兜底找最近的可点 button。
 */
function selectDotAtPoint(x: number, y: number): void {
  const el = document.elementFromPoint(x, y) as Element | null
  if (!el) return
  // 落在 button 上（或里面的 span）——closest 一直往上找直到 button
  const button = el.closest('button')
  if (!button) return
  const idx = dotRefs.value.indexOf(button as HTMLElement)
  if (idx === -1) return
  select(levels.value[idx]!)
}

onMounted(() => {
  document.addEventListener('click', handleOutsideClick, true)
})

onBeforeUnmount(() => {
  // 组件卸载时若还挂着拖拽监听，要清理掉防止 leak
  document.removeEventListener('pointermove', onPointerMove)
  document.removeEventListener('pointerup', onPointerUp)
  document.removeEventListener('click', handleOutsideClick, true)
})
</script>
