<template>
  <!--
    思考强度控件——按钮 + 弹出横向 segmented 滑块。

    合并了旧的 effort <select> + thinking 开关按钮（统一到 EffortLevel 数轴）：
      - 'none' = 关闭/压低思考（codex 零 reasoning token；claude 压到 --effort low）
      - low/medium/high/xhigh/max = 透传给后端的 effort 档位

    折叠态：脑图标 + 当前档位 label，点击展开 popover。
    展开态：横向档位（off/low/med/high/xhigh/MAX），点击即切。
    max 档激活时：触发按钮 + 弹出层里 max 单元都变紫色脉冲，表示极致性能。

    弹层用项目既有约定（手写 absolute z-50 + ref，不用 radix），
    见 WorkspaceSwitcher.vue。外加 clickOutside 收起。
  -->
  <div ref="rootEl" class="relative">
    <!-- 折叠态触发按钮 -->
    <button
      type="button"
      class="flex items-center gap-1 px-2 py-1 rounded transition-colors"
      :class="triggerClass"
      :title="triggerTitle"
      @click="open = !open"
    >
      <BrainIcon class="w-3 h-3" />
      <span class="text-[11px]">{{ effortLabel }}</span>
      <ChevronDownIcon
        class="w-2.5 h-2.5 flex-shrink-0 transition-transform"
        :class="open ? 'rotate-180' : ''"
      />
    </button>

    <!-- 弹出横向滑块 -->
    <div
      v-if="open"
      class="absolute bottom-full left-0 mb-2 z-50 rounded-md border border-border bg-popover p-1 shadow-lg flex items-center gap-0.5"
    >
      <button
        v-for="level in levels"
        :key="level"
        type="button"
        class="px-2 py-1 rounded text-[11px] transition-colors whitespace-nowrap"
        :class="tierClass(level)"
        :title="tierTitle(level)"
        @click="onSelect(level)"
      >
        {{ tierLabel(level) }}
      </button>
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

/**
 * 实际渲染的档位列表——capabilities.supportedEfforts 前面补一个虚拟 'none' 档。
 * 'none' 永远在最前（表示"关闭思考"），即使后端 capabilities 没声明也显示。
 * 同时过滤掉 supported 里可能误带的 'none'（避免重复）。
 */
const levels = computed<EffortLevel[]>(() => {
  const filtered = props.supported.filter((l) => l !== 'none')
  return ['none', ...filtered]
})

const isMax = computed(() => props.modelValue === 'max')

/**
 * 触发按钮的 class——三态：
 *   - none：暗灰（关闭思考，刻意弱化视觉权重）
 *   - max：紫色脉冲（极致性能的视觉反馈）
 *   - 其他：主题主色高亮
 */
const triggerClass = computed(() => {
  if (props.modelValue === 'none') {
    return 'bg-secondary text-secondary-foreground/50 hover:text-secondary-foreground'
  }
  if (isMax.value) {
    return 'bg-brain/20 text-brain animate-pulse shadow-[0_0_8px_rgba(168,85,247,0.5)]'
  }
  return 'bg-primary/15 text-primary'
})

const triggerTitle = computed(() => {
  if (props.modelValue === 'none') return '思考：关（点击调节）'
  if (isMax.value) return '思考：极致性能（点击调节）'
  return `思考：${effortLabel.value}（点击调节）`
})

/** 触发按钮上显示的档位文案 */
const effortLabel = computed(() => tierLabel(props.modelValue))

/** 档位 → UI 文案。max 用大写强调。medium 缩成 med 省宽度。 */
function tierLabel(level: EffortLevel): string {
  switch (level) {
    case 'none':
      return 'off'
    case 'low':
      return 'low'
    case 'medium':
      return 'med'
    case 'high':
      return 'high'
    case 'xhigh':
      return 'xhigh'
    case 'max':
      return 'MAX'
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

/**
 * 弹出层里单个档位的 class：
 *   - 当前选中档位高亮
 *   - max 档选中时额外加紫色脉冲（区别于普通选中态的 primary 色）
 *   - 未选中档位保持 muted，hover 用 accent
 */
function tierClass(level: EffortLevel): string {
  const selected = level === props.modelValue
  if (level === 'max' && selected) {
    return 'bg-brain text-brain-foreground animate-pulse shadow-[0_0_8px_rgba(168,85,247,0.5)]'
  }
  if (selected) {
    return 'bg-primary text-primary-foreground'
  }
  return 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
}

function onSelect(level: EffortLevel): void {
  emit('update:modelValue', level)
  open.value = false
}

/**
 * clickOutside 收起弹层——点弹层外任意位置时关闭。
 * 项目目前没有 v-click-outside 指令，这里手写最简版（参考 WorkspaceSwitcher 约定扩展）。
 * 用 capture 阶段抓事件，避免按钮自身的 click 先冒泡导致开-关打架。
 */
function handleOutsideClick(e: MouseEvent): void {
  if (!open.value) return
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) {
    open.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', handleOutsideClick, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleOutsideClick, true)
})
</script>
