<template>
  <!--
    通用右键菜单——按屏幕坐标浮出的一层操作列表。

    与 DropdownMenu 的区别：那个是挂在 trigger 按钮下方的单选下拉（有选中态、
    有 v-model）；这个没有 trigger、没有选中态，位置来自鼠标事件坐标，是一次性
    的动作菜单。两者语义不同，不复用。

    - Teleport 到 body：菜单不能被会话列表的 overflow-y:auto 裁掉
    - fixed 定位 + 视口翻转：贴近右/下边缘时朝反方向展开，不出屏
    - Esc / 点击外部 / 窗口滚动或缩放 都关闭（右键菜单不该跟着页面飘）
  -->
  <Teleport to="body">
    <div
      ref="menuEl"
      class="fixed z-100 min-w-44 rounded-md border border-border bg-popover p-1 shadow-lg"
      :style="{ left: `${position.x}px`, top: `${position.y}px` }"
      role="menu"
    >
      <template v-for="item in items" :key="item.key">
        <div v-if="item.separator" class="my-1 h-px bg-border" role="separator" />
        <button
          v-else
          type="button"
          role="menuitem"
          :disabled="item.disabled"
          class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded text-[length:var(--ui-text-base)] text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          :class="
            item.danger
              ? 'text-destructive hover:bg-destructive/10'
              : 'text-popover-foreground hover:bg-accent hover:text-accent-foreground'
          "
          @click="onSelect(item)"
        >
          <component :is="item.icon" v-if="item.icon" class="w-3.5 h-3.5 flex-shrink-0" />
          <span class="truncate flex-1">{{ item.label }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'

export interface ContextMenuItem {
  /** 唯一标识——select 事件回传它，调用方据此分发动作 */
  key: string
  label: string
  /** lucide 图标组件，可不传 */
  icon?: Component
  /** 危险操作（删除类）——红色文字 + 红色 hover 底 */
  danger?: boolean
  disabled?: boolean
  /** true 时渲染成一条分隔线，label/key 之外的字段都忽略 */
  separator?: boolean
}

const props = defineProps<{
  /** 触发点的视口坐标（一般直接用 MouseEvent 的 clientX/clientY） */
  x: number
  y: number
  items: ContextMenuItem[]
}>()

const emit = defineEmits<{
  select: [key: string]
  close: []
}>()

const menuEl = ref<HTMLElement | null>(null)
/**
 * 实际渲染位置。初值就是鼠标位置，挂载后量到真实尺寸再按视口边界翻转——
 * 菜单高度取决于条目数，只能等 DOM 出来才知道。
 */
const position = ref({ x: props.x, y: props.y })

/** 贴边翻转：右边放不下就朝左展开，下边放不下就朝上展开，两边都留 8px 余量 */
function flipIntoViewport(): void {
  const el = menuEl.value
  if (!el) return
  const { width, height } = el.getBoundingClientRect()
  const margin = 8
  let { x, y } = position.value
  if (x + width + margin > window.innerWidth) x = Math.max(margin, x - width)
  if (y + height + margin > window.innerHeight) y = Math.max(margin, y - height)
  position.value = { x, y }
}

/**
 * 坐标变了就重新定位。
 *
 * 必需，不是优化：菜单开着时在别处再右键，调用方通常是"关掉 + 重开"，但 Vue 看到
 * v-if 在同一 tick 内 false→true 会复用这个组件实例，onMounted 不会再跑一次——
 * 少了这个 watch，菜单就钉在上一次的位置不动。
 */
watch(
  () => [props.x, props.y],
  async ([x, y]) => {
    position.value = { x: x!, y: y! }
    await nextTick()
    flipIntoViewport()
  },
)

function onSelect(item: ContextMenuItem): void {
  if (item.disabled) return
  emit('select', item.key)
  emit('close')
}

/**
 * 点击外部关闭——capture 阶段监听，且 mousedown 而非 click：
 * 用户在菜单外按下鼠标的瞬间就该收起，等到 click（mouseup）会让菜单在拖动
 * 选择文字之类的操作中挂着不动。
 */
function onPointerDownOutside(e: MouseEvent): void {
  if (menuEl.value && !menuEl.value.contains(e.target as Node)) emit('close')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}

function close(): void {
  emit('close')
}

onMounted(async () => {
  await nextTick()
  flipIntoViewport()
  document.addEventListener('mousedown', onPointerDownOutside, true)
  document.addEventListener('contextmenu', onPointerDownOutside, true)
  document.addEventListener('keydown', onKeydown)
  // capture 阶段监听 scroll：菜单是 fixed 的，页面一滚就跟内容脱节了，直接关掉
  window.addEventListener('scroll', close, true)
  window.addEventListener('resize', close)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onPointerDownOutside, true)
  document.removeEventListener('contextmenu', onPointerDownOutside, true)
  document.removeEventListener('keydown', onKeydown)
  window.removeEventListener('scroll', close, true)
  window.removeEventListener('resize', close)
})
</script>
