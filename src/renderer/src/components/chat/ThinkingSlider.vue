<template>
  <!--
    思考强度控件——圆点轨道（对齐 Claude Code）。

    N 个小圆点排成横线，当前档位的圆点实心填充（亮色），其他档位灰阶递减：
      - 当前选中档：实心 foreground 色（dark 下亮白、light 下深灰）
      - 左侧已"经过"档：中灰（muted-foreground/70）
      - 右侧未到达档：暗灰（muted-foreground/30）

    max 档激活时：该圆点变紫色填充 + 脉冲动画 + 稍大尺寸，表示极致性能。

    'none' 永远在最前（虚拟档，表示关闭思考）。
    点击任意圆点即切到该档；hover 显示 tooltip 文案。
  -->
  <div
    ref="rootEl"
    class="relative flex items-center gap-1.5 px-2 py-1.5 rounded transition-colors hover:bg-accent/50"
    :title="triggerTitle"
  >
    <BrainIcon
      class="w-3 h-3 flex-shrink-0"
      :class="
        modelValue === 'none'
          ? 'text-muted-foreground/50'
          : isMax
            ? 'text-brain'
            : 'text-foreground'
      "
    />

    <!-- 圆点轨道 -->
    <div class="flex items-center gap-1.5">
      <button
        v-for="level in levels"
        :key="level"
        type="button"
        class="p-0.5 transition-all duration-150 cursor-pointer"
        :class="level === 'max' && isMax ? 'animate-pulse' : ''"
        :title="tierTitle(level)"
        @click="onSelect(level)"
      >
        <span
          class="block rounded-full transition-all duration-150"
          :class="[level === 'max' && isMax ? 'w-2 h-2' : 'w-1.5 h-1.5', dotFillClass(level)]"
        />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { EffortLevel } from '@shared/backend/types'
import { BrainIcon } from 'lucide-vue-next'
import { computed } from 'vue'

const props = defineProps<{
  /** 当前 effort 值（双向绑定，v-model） */
  modelValue: EffortLevel
  /** 该后端实际支持的档位（来自 capabilities.supportedEfforts） */
  supported: EffortLevel[]
}>()
const emit = defineEmits<{
  'update:modelValue': [value: EffortLevel]
}>()

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
  if (props.modelValue === 'none') return '思考：关（点击圆点调节）'
  if (isMax.value) return '思考：极致性能（点击圆点调节）'
  return `思考：${tierLabel(props.modelValue)}（点击圆点调节）`
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

/** 档位 → UI 文案（用于 tooltip 和 triggerTitle 拼接） */
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

function onSelect(level: EffortLevel): void {
  emit('update:modelValue', level)
}
</script>
