<template>
  <!--
    权限模式盾牌按钮——点击展开权限模式下拉。

    跟 DropdownMenu 视觉/交互对齐(placement=top 向上展开),但 trigger 是盾牌图标
    而非文字按钮。不同权限模式对应不同盾牌变体 + 颜色:

      default          → ShieldQuestionMark(问号盾牌,每次问)
      acceptEdits/auto → ShieldCheck(对勾盾牌,自动通过)
      plan             → ShieldEllipsis(省略号盾牌,只规划)
      dontAsk          → ShieldMinus(减号盾牌,不问)
      bypassPermissions→ ShieldAlert + 警告色(完全跳过,有风险)

    bypassPermissions 用 amber 警告色(而非 destructive 红)——它是"用户主动选择跳过",
    是警告级别而非错误级别。颜色用 text-amber-500 dark:text-amber-400。
  -->
  <div ref="rootEl" class="relative inline-block">
    <button
      type="button"
      :title="triggerTitle"
      class="flex items-center justify-center w-7 h-7 rounded-md text-sm transition-colors bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-pointer"
      @click="open = !open"
    >
      <component :is="shieldIcon" class="w-4 h-4 flex-shrink-0" :class="shieldColor" />
    </button>

    <!-- 弹层:权限选项列表(向上展开,避开窗口底部)
         w-max 让宽度跟随内容(最长选项),不再有空白。
         right-0 右对齐——盾牌按钮在右侧时,弹层向左展开不被裁切。 -->
    <div
      v-if="open"
      class="absolute bottom-full mb-1 right-0 z-50 w-max max-w-[20rem] rounded-md border border-border bg-popover p-1 shadow-lg"
    >
      <button
        v-for="opt in options"
        :key="String(opt.value)"
        type="button"
        class="w-full flex items-center gap-2.5 px-3 py-2 rounded text-sm text-left transition-colors text-popover-foreground hover:bg-accent hover:text-accent-foreground"
        :class="opt.value === modelValue ? 'bg-accent/60 text-accent-foreground' : ''"
        @click="onSelect(opt.value)"
      >
        <CheckIcon v-if="opt.value === modelValue" class="w-4 h-4 flex-shrink-0 text-foreground" />
        <span v-else class="w-4 h-4 flex-shrink-0" />
        <span class="truncate flex-1">{{ opt.label }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PermissionMode } from '@shared/backend/types'
import {
  CheckIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldEllipsisIcon,
  ShieldMinusIcon,
  ShieldQuestionMarkIcon,
} from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

interface Option {
  value: PermissionMode
  label: string
}

const props = defineProps<{
  modelValue: PermissionMode
  options: Option[]
}>()
const emit = defineEmits<{
  'update:modelValue': [value: PermissionMode]
}>()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)

/**
 * 当前权限模式对应的盾牌图标组件。
 * 每种模式一个变体,语义化映射:
 *   - default: 问号(每次都问)
 *   - acceptEdits/auto: 对勾(自动通过)
 *   - plan: 省略号(只规划不执行)
 *   - dontAsk: 减号(不问)
 *   - bypassPermissions: 警告(完全跳过,有风险)
 */
const shieldIcon = computed(() => {
  switch (props.modelValue) {
    case 'acceptEdits':
    case 'auto':
      return ShieldCheckIcon
    case 'plan':
      return ShieldEllipsisIcon
    case 'dontAsk':
      return ShieldMinusIcon
    case 'bypassPermissions':
      return ShieldAlertIcon
    default:
      return ShieldQuestionMarkIcon
  }
})

/**
 * 盾牌颜色——bypassPermissions 用 amber 警告色,其他默认跟随文本色。
 * amber 而非 destructive(红):bypass 是用户主动选择的"跳过",属警告级别非错误。
 */
const shieldColor = computed(() => {
  if (props.modelValue === 'bypassPermissions') {
    return 'text-amber-500 dark:text-amber-400'
  }
  return ''
})

const triggerTitle = computed(() => {
  const current = props.options.find((o) => o.value === props.modelValue)
  const label = current?.label ?? props.modelValue
  const suffix = props.modelValue === 'bypassPermissions' ? '(⚠ 完全跳过权限)' : ''
  return `权限模式: ${label} ${suffix}`
})

function onSelect(value: PermissionMode): void {
  emit('update:modelValue', value)
  open.value = false
}

/**
 * clickOutside 收起弹层——capture 阶段抓事件,跟 ThinkingSlider/DropdownMenu 一致。
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
