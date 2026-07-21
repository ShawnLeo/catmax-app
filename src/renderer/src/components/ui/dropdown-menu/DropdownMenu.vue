<template>
  <!--
    通用单选下拉菜单——trigger 按钮 + popover 选项列表。

    替换原生 <select>：原生元素在不同平台渲染差异大、样式难以统一，
    这里手写 popover 跟项目既有约定（WorkspaceSwitcher/ThinkingSlider）一致。

    - 泛型 T：option.value 的类型，v-model 双向绑定
    - 选中项显示 CheckIcon
    - clickOutside 自动收起（capture 阶段，避免 trigger 自身 click 打架）
    - align='right' 时弹层右对齐（给 trigger 靠右的场景用）
    - placement='top' 时弹层向上展开（给 trigger 贴近窗口底部的场景用，如 Composer）
    - triggerLabel：未传时显示当前选中项的 label；都没有时显示 placeholder
  -->
  <div ref="rootEl" class="relative inline-block">
    <button
      type="button"
      :title="title"
      :disabled="disabled"
      class="flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      @click="onTriggerClick"
    >
      <span class="truncate max-w-[180px]">{{ triggerLabel }}</span>
      <ChevronDownIcon
        class="w-3.5 h-3.5 flex-shrink-0 transition-transform"
        :class="open ? 'rotate-180' : ''"
      />
    </button>

    <div
      v-if="open"
      :class="[
        'absolute z-50 min-w-[12rem] max-w-[20rem] rounded-md border border-border bg-popover p-1 shadow-lg',
        placement === 'top' ? 'bottom-full mb-1' : 'mt-1',
        align === 'right' ? 'right-0' : 'left-0',
      ]"
    >
      <button
        v-for="opt in options"
        :key="String(opt.value)"
        type="button"
        :disabled="opt.disabled"
        :title="opt.title"
        class="w-full flex items-center gap-2.5 px-3 py-2 rounded text-sm text-left transition-colors text-popover-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40 disabled:cursor-not-allowed"
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

<script setup lang="ts" generic="T extends string | null">
import { CheckIcon, ChevronDownIcon } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

export interface DropdownOption<V> {
  value: V
  label: string
  disabled?: boolean
  /** 显式允许 undefined——exactOptionalPropertyTypes 下 option 构造时可以不传 */
  title?: string | undefined
}

const props = withDefaults(
  defineProps<{
    /** 当前选中值（v-model） */
    modelValue: T
    /** 选项列表 */
    options: DropdownOption<T>[]
    /** 未选中时显示的占位文案 */
    placeholder?: string
    /** 弹层对齐方向 */
    align?: 'left' | 'right'
    /** 弹层展开方向：bottom（默认，向下）或 top（向上，给 trigger 贴近窗口底部用） */
    placement?: 'top' | 'bottom'
    /** trigger 按钮 tooltip——显式允许 undefined（exactOptionalPropertyTypes） */
    title?: string | undefined
    /** 禁用整个下拉 */
    disabled?: boolean
  }>(),
  {
    align: 'left',
    placement: 'bottom',
    disabled: false,
  },
)
const emit = defineEmits<{
  'update:modelValue': [value: T]
}>()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)

/**
 * trigger 按钮显示的文案：
 *   - 当前选中项的 label（优先）
 *   - 都没选中时显示 placeholder
 *   - placeholder 未传时显示空串（按钮宽度由 chevron 撑起）
 */
const triggerLabel = computed(() => {
  const current = props.options.find((o) => o.value === props.modelValue)
  if (current) return current.label
  return props.placeholder ?? ''
})

function onTriggerClick(): void {
  if (props.disabled) return
  open.value = !open.value
}

function onSelect(value: T): void {
  emit('update:modelValue', value)
  open.value = false
}

/**
 * clickOutside 收起——capture 阶段抓事件，避免 trigger 自身 click 先冒泡导致开-关打架。
 * 跟 ThinkingSlider 的实现一致（项目目前没有 v-click-outside 指令）。
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
