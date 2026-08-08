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
  <div
    ref="rootEl"
    :class="['relative', fullWidth ? 'block w-full' : 'inline-block flex-shrink-0']"
  >
    <!--
      splitAction 模式：trigger 拆成两块——
      - 图标区（左）：点击触发 action 事件，不展开菜单（Open With：用选中应用打开）
      - 箭头区（右）：点击只展开/收起菜单，不触发 action
      非 splitAction：保持原样，整块 trigger 既切菜单。
    -->
    <div
      v-if="splitAction"
      class="flex items-stretch rounded-md overflow-hidden bg-secondary text-secondary-foreground"
    >
      <button
        type="button"
        :title="actionTitle ?? title"
        :disabled="disabled || !triggerIcon"
        class="flex items-center gap-2 px-1.5 py-1.5 rounded-l-md transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none"
        @click.stop="emit('action')"
      >
        <img
          v-if="triggerIcon"
          :src="triggerIcon"
          alt=""
          class="w-4 h-4 flex-shrink-0 object-contain"
        />
        <span v-else class="w-4 h-4 flex-shrink-0" />
      </button>
      <button
        type="button"
        :title="title"
        :disabled="disabled"
        class="flex items-center px-1 rounded-r-md transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none"
        @click="onTriggerClick"
      >
        <ChevronDownIcon
          class="w-3 h-3 flex-shrink-0 transition-transform"
          :class="open ? 'rotate-180' : ''"
        />
      </button>
    </div>
    <button
      v-else
      type="button"
      :title="title"
      :disabled="disabled"
      class="flex items-center gap-2 rounded-md text-[length:var(--ui-text-base)] transition-colors bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      :class="[fullWidth ? 'w-full' : '', iconOnly && triggerIcon ? 'px-1.5 py-1.5' : 'px-3 py-2']"
      :style="triggerStyle"
      @click="onTriggerClick"
    >
      <img
        v-if="triggerIcon"
        :src="triggerIcon"
        alt=""
        class="w-4 h-4 flex-shrink-0 object-contain"
      />
      <!-- iconOnly 模式下有图标就只画图标（标签和箭头都隐藏），点引用图标即用此应用打开 -->
      <span v-if="!(iconOnly && triggerIcon)" class="truncate flex-1">{{ triggerLabel }}</span>
      <ChevronDownIcon
        v-if="!(iconOnly && triggerIcon)"
        class="w-4 h-4 flex-shrink-0 transition-transform"
        :class="open ? 'rotate-180' : ''"
      />
    </button>

    <div
      v-if="open"
      ref="popoverEl"
      :class="[
        'absolute z-50 w-max max-w-[20rem] rounded-md border border-border bg-popover p-1 shadow-lg',
        placement === 'top' ? 'bottom-full mb-1' : 'mt-1',
        // alignFlipped 是运行时视口翻转结果：右边放不下就强制左对齐，左边放不下强制右对齐
        effectiveAlign === 'right' ? 'right-0' : 'left-0',
      ]"
    >
      <button
        v-for="opt in options"
        :key="String(opt.value)"
        type="button"
        :disabled="opt.disabled"
        :title="opt.title"
        class="w-full flex items-center gap-2.5 px-3 py-2 rounded text-[length:var(--ui-text-base)] text-left transition-colors text-popover-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40 disabled:cursor-not-allowed"
        :class="opt.value === modelValue ? 'bg-accent/60 text-accent-foreground' : ''"
        @click="onSelect(opt.value)"
      >
        <CheckIcon v-if="opt.value === modelValue" class="w-4 h-4 flex-shrink-0 text-foreground" />
        <img
          v-else-if="opt.icon"
          :src="opt.icon"
          alt=""
          class="w-4 h-4 flex-shrink-0 object-contain"
        />
        <span v-else class="w-4 h-4 flex-shrink-0" />
        <span class="truncate flex-1">{{ opt.label }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts" generic="T extends string | null">
import { CheckIcon, ChevronDownIcon } from 'lucide-vue-next'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

export interface DropdownOption<V> {
  value: V
  label: string
  disabled?: boolean
  /** 显式允许 undefined——exactOptionalPropertyTypes 下 option 构造时可以不传 */
  title?: string | undefined
  /** 选项图标（data URL 或 URL），在文字左侧渲染。给「打开方式」这类带图标的选项用 */
  icon?: string
}

const props = withDefaults(
  defineProps<{
    /** 当前选中值（v-model） */
    modelValue: T
    /** 选项列表 */
    options: DropdownOption<T>[]
    /** 未选中时显示的占位文案 */
    placeholder?: string
    /**
     * 显式覆盖 trigger 显示文案——优先级最高。
     * 不传时回退到当前选中项的 label。
     * 用于"完整 label 在弹层显示,trigger 显示短名"这类场景(如 Model)。
     */
    triggerLabel?: string
    /** 弹层对齐方向 */
    align?: 'left' | 'right'
    /** 弹层展开方向：bottom（默认，向下）或 top（向上，给 trigger 贴近窗口底部用） */
    placement?: 'top' | 'bottom'
    /** trigger 按钮 tooltip——显式允许 undefined（exactOptionalPropertyTypes） */
    title?: string | undefined
    /** 禁用整个下拉 */
    disabled?: boolean
    /**
     * trigger 按钮固定宽度（px）。不传时按钮宽度由内容撑开。
     * 用于"模型名长度差异大但不想让按钮被撑得跳来跳去"这类场景。
     */
    triggerWidth?: number
    /** trigger 撑满父容器宽度（root + button 均 w-full）。表单栅格场景用。 */
    fullWidth?: boolean
    /**
     * iconOnly 模式：选中项有图标时，trigger 只画图标（隐藏文案和箭头）。
     * 给「打开方式」这类纯图标选择器用——选中 IDE 后顶栏只显示那个 IDE 的图标。
     */
    iconOnly?: boolean
    /**
     * splitAction 模式：trigger 拆成「图标区 + 箭头区」两块。
     * 点图标区触发 action 事件（不展开菜单），点箭头区展开菜单。
     * 给「打开方式」用：点图标 = 用选中应用打开工作区，点箭头 = 选 IDE。
     */
    splitAction?: boolean
    /** splitAction 模式下图标区的 tooltip（默认回退到 title） */
    actionTitle?: string | undefined
  }>(),
  {
    align: 'left',
    placement: 'bottom',
    disabled: false,
    fullWidth: false,
    iconOnly: false,
    splitAction: false,
  },
)
const emit = defineEmits<{
  'update:modelValue': [value: T]
  /** splitAction 模式：点图标区时触发，调用方据此执行打开动作 */
  action: []
}>()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)
const popoverEl = ref<HTMLElement | null>(null)
/**
 * 运行时视口翻转结果——null 表示用 align prop 原值，'left'/'right' 表示翻过去了。
 * 每次 open 时先重置，DOM 出来后量尺寸决定要不要翻。
 */
const alignFlipped = ref<'left' | 'right' | null>(null)
const effectiveAlign = computed(() => alignFlipped.value ?? props.align)

/**
 * 视口翻转：贴右/左边缘放不下时朝反方向展开。
 * 弹层宽度取决于选项内容，只能等 DOM 出来才知道。trigger 越靠窗口右边，默认左对齐
 * （align='left'）的弹层越容易越界——这是顶栏靠右的「打开方式」被裁的直接原因。
 */
async function flipIntoViewport(): Promise<void> {
  const pop = popoverEl.value
  if (!pop) return
  const { left, right, width } = pop.getBoundingClientRect()
  const margin = 8
  // 当前是 left 对齐且右边溢出 → 翻成 right；当前是 right 对齐且左边溢出 → 翻成 left
  if (effectiveAlign.value === 'left' && right + margin > window.innerWidth) {
    // 只有翻过去后左边不溢出才翻，否则保持原样（两边都溢出时优先靠左）
    if (left - width >= margin) alignFlipped.value = 'right'
  } else if (effectiveAlign.value === 'right' && left - margin < 0) {
    if (right + width <= window.innerWidth - margin) alignFlipped.value = 'left'
  }
}

const triggerStyle = computed(() =>
  typeof props.triggerWidth === 'number' ? { width: `${props.triggerWidth}px` } : undefined,
)

/**
 * trigger 上显示的图标：当前选中项的 icon（若有），让用户一眼看到选中的是哪个应用。
 * 未选中或选中项无图标时不显示。
 */
const triggerIcon = computed(() => {
  const current = props.options.find((o) => o.value === props.modelValue)
  return current?.icon
})

/**
 * trigger 按钮显示的文案（优先级从高到低）：
 *   1. 显式传入的 triggerLabel prop(覆盖,用于显示短名)
 *   2. 当前选中项的 label
 *   3. placeholder
 *   4. 空串(按钮宽度由 chevron 撑起)
 */
const triggerLabel = computed(() => {
  if (props.triggerLabel !== undefined) return props.triggerLabel
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

// 弹层打开后量尺寸做视口翻转；关闭时重置翻转状态，下次打开重新算。
watch(open, async (isOpen) => {
  if (!isOpen) {
    alignFlipped.value = null
    return
  }
  await nextTick()
  await flipIntoViewport()
})

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
