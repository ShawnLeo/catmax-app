<template>
  <!--
    通用右键菜单——按屏幕坐标浮出的一层操作列表。

    与 DropdownMenu 的区别：那个是挂在 trigger 按钮下方的单选下拉（有选中态、
    有 v-model）；这个没有 trigger、没有选中态，位置来自鼠标事件坐标，是一次性
    的动作菜单。两者语义不同，不复用。

    - Teleport 到 body：菜单不能被会话列表的 overflow-y:auto 裁掉
    - fixed 定位 + 视口翻转：贴近右/下边缘时朝反方向展开，不出屏
    - Esc / 点击外部 / 窗口滚动或缩放 都关闭（右键菜单不该跟着页面飘）
    - 支持二级子菜单：带 children 的条目 hover 时在右侧展开二级面板，
      命中视口右边缘则翻到左侧（File Context Menu 的「打开方式」用）
  -->
  <Teleport to="body">
    <div
      ref="menuEl"
      class="fixed z-100 min-w-44 rounded-md border border-border bg-popover p-1 shadow-lg"
      :style="{ left: `${position.x}px`, top: `${position.y}px` }"
      role="menu"
      @mouseleave="onMenuMouseLeave"
    >
      <template v-for="item in items" :key="item.key">
        <div v-if="item.separator" class="my-1 h-px bg-border" role="separator" />
        <div
          v-else
          ref="itemRefs"
          class="relative"
          :data-item-key="item.key"
          @mouseenter="onItemEnter(item)"
          @mouseleave="onItemLeave(item)"
        >
          <button
            type="button"
            role="menuitem"
            :disabled="item.disabled"
            :aria-haspopup="item.children ? 'menu' : undefined"
            :aria-expanded="item.children ? openParentKey === item.key : undefined"
            class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded text-[length:var(--ui-text-base)] text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            :class="itemClass(item)"
            @click="onSelect(item)"
          >
            <component :is="item.icon" v-if="item.icon" class="w-3.5 h-3.5 flex-shrink-0" />
            <img
              v-else-if="item.iconUrl"
              :src="item.iconUrl"
              alt=""
              class="w-3.5 h-3.5 flex-shrink-0 object-contain"
            />
            <span class="truncate flex-1">{{ item.label }}</span>
            <!-- 二级菜单展开指示：只有带 children 的条目才画箭头 -->
            <ChevronRightIcon
              v-if="item.children"
              class="w-3 h-3 flex-shrink-0 text-muted-foreground"
            />
          </button>
        </div>
      </template>
    </div>

    <!--
      二级子菜单——独立 Teleport 出来另起一层，避免父菜单 overflow 影响。
      定位来自父条目按钮的 getBoundingClientRect，右侧放不下翻左侧。
    -->
    <Teleport v-if="submenuParent && submenuItems.length > 0" to="body">
      <div
        ref="submenuEl"
        class="fixed z-101 min-w-44 rounded-md border border-border bg-popover p-1 shadow-lg"
        :style="{ left: `${submenuPosition.x}px`, top: `${submenuPosition.y}px` }"
        role="menu"
        @mouseenter="onSubmenuMouseEnter"
        @mouseleave="onSubmenuMouseLeave"
      >
        <template v-for="child in submenuItems" :key="child.key">
          <div v-if="child.separator" class="my-1 h-px bg-border" role="separator" />
          <button
            v-else
            type="button"
            role="menuitem"
            :disabled="child.disabled"
            class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded text-[length:var(--ui-text-base)] text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            :class="
              child.danger
                ? 'text-destructive hover:bg-destructive/10'
                : 'text-popover-foreground hover:bg-accent hover:text-accent-foreground'
            "
            @click="onSubmenuSelect(child)"
          >
            <component :is="child.icon" v-if="child.icon" class="w-3.5 h-3.5 flex-shrink-0" />
            <img
              v-else-if="child.iconUrl"
              :src="child.iconUrl"
              alt=""
              class="w-3.5 h-3.5 flex-shrink-0 object-contain"
            />
            <span class="truncate flex-1">{{ child.label }}</span>
          </button>
        </template>
      </div>
    </Teleport>
  </Teleport>
</template>

<script setup lang="ts">
import { ChevronRightIcon } from 'lucide-vue-next'
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'

export interface ContextMenuItem {
  /** 唯一标识——select 事件回传它，调用方据此分发动作 */
  key: string
  label: string
  /** lucide 图标组件，可不传 */
  icon?: Component
  /** 图标 data URL（应用图标等）。icon（lucide）和 iconUrl 同时给时优先 icon */
  iconUrl?: string
  /** 危险操作（删除类）——红色文字 + 红色 hover 底 */
  danger?: boolean
  disabled?: boolean
  /** true 时渲染成一条分隔线，label/key 之外的字段都忽略 */
  separator?: boolean
  /**
   * 二级子菜单条目。存在时该项右侧画出展开箭头，hover 时在右侧展开二级面板；
   * 选中子项时 select 事件回传 `父key/子key`。
   * File Context Menu 的「打开方式」用——children 可在 hover 时懒加载填充。
   */
  children?: ContextMenuItem[]
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
  /**
   * 父条目（带 children）被 hover 时触发，调用方可借此懒加载二级内容——
   * 在 children 还是占位（如「正在读取…」）时发起查询并替换 items 里对应项。
   */
  openParent: [key: string]
}>()

const menuEl = ref<HTMLElement | null>(null)
const submenuEl = ref<HTMLElement | null>(null)
const itemRefs = ref<HTMLElement[]>([])
/**
 * 实际渲染位置。初值就是鼠标位置，挂载后量到真实尺寸再按视口边界翻转——
 * 菜单高度取决于条目数，只能等 DOM 出来才知道。
 */
const position = ref({ x: props.x, y: props.y })

/** 当前展开二级菜单的父条目 key（null 表示没有二级菜单打开） */
const openParentKey = ref<string | null>(null)

const submenuParent = ref<ContextMenuItem | null>(null)
const submenuItems = ref<ContextMenuItem[]>([])
const submenuPosition = ref({ x: 0, y: 0 })

/** 打开/关闭二级菜单之间的延迟计时器——避免在相邻条目间移动时闪烁 */
let hoverTimer: ReturnType<typeof setTimeout> | null = null
const HOVER_OPEN_DELAY = 120
const HOVER_CLOSE_DELAY = 200

function clearHoverTimer(): void {
  if (hoverTimer) {
    clearTimeout(hoverTimer)
    hoverTimer = null
  }
}

function itemClass(item: ContextMenuItem): string {
  const isOpen = item.children && openParentKey.value === item.key
  if (item.danger) return 'text-destructive hover:bg-destructive/10'
  return isOpen
    ? 'text-popover-foreground bg-accent'
    : 'text-popover-foreground hover:bg-accent hover:text-accent-foreground'
}

function onItemEnter(item: ContextMenuItem): void {
  if (item.separator || item.disabled) return
  clearHoverTimer()
  if (item.children) {
    // 切到另一个带 children 的父条目：延迟一点再换，避免擦边时反复打开关闭
    hoverTimer = setTimeout(() => openSubmenu(item), HOVER_OPEN_DELAY)
  } else if (openParentKey.value !== null) {
    // 移到一个普通条目：延迟关闭二级菜单，给鼠标穿过间隙留时间
    hoverTimer = setTimeout(() => closeSubmenu(), HOVER_CLOSE_DELAY)
  }
}

function onItemLeave(item: ContextMenuItem): void {
  // 离开带 children 的条目时若鼠标是奔向二级面板，onSubmenuMouseEnter 会接管；
  // 这里只清掉待打开计时器（防止擦边触发），关闭交给 onMenuMouseLeave / 子面板。
  if (item.children) clearHoverTimer()
}

/** 鼠标彻底离开父菜单且不在二级面板里——整个关掉（由二级面板的 leave 兜底反向） */
function onMenuMouseLeave(): void {
  if (openParentKey.value !== null) {
    hoverTimer = setTimeout(() => closeSubmenu(), HOVER_CLOSE_DELAY)
  }
}

/**
 * 鼠标进入二级面板——清掉待关闭计时器，面板保持打开。
 *
 * 关键：父菜单和二级面板是两个各自 Teleport 到 body 的元素，中间有物理间隙。
 * 鼠标从父条目移向二级面板时会先离开父菜单（触发 onMenuMouseLeave / onItemLeave
 * 排了一个延时关闭），穿到面板上的那一刻必须由这里取消关闭，否则面板会被收掉，
 * 鼠标根本停不住——这正是「划出应用后鼠标移不过去」的原因。
 */
function onSubmenuMouseEnter(): void {
  clearHoverTimer()
}

function onSubmenuMouseLeave(): void {
  hoverTimer = setTimeout(() => closeSubmenu(), HOVER_CLOSE_DELAY)
}

async function openSubmenu(item: ContextMenuItem): Promise<void> {
  if (!item.children) return
  openParentKey.value = item.key
  submenuParent.value = item
  submenuItems.value = item.children
  // 通知调用方可以懒加载二级内容（如「打开方式」的应用列表查询）
  emit('openParent', item.key)
  await nextTick()
  positionSubmenu()
}

function closeSubmenu(): void {
  openParentKey.value = null
  submenuParent.value = null
  submenuItems.value = []
}

/** 二级菜单定位：贴在父条目右侧、与父条目顶部对齐；右侧放不下翻左侧 */
function positionSubmenu(): void {
  const parent = submenuParent.value
  if (!parent) return
  const parentEl = itemRefs.value.find((el) => el.dataset['itemKey'] === parent.key)
  const sub = submenuEl.value
  if (!parentEl || !sub) return
  const rect = parentEl.getBoundingClientRect()
  const { width: subW, height: subH } = sub.getBoundingClientRect()
  const margin = 8
  // 默认放右侧、顶部对齐；右边缘放不下翻左侧
  let x = rect.right
  if (x + subW + margin > window.innerWidth) x = Math.max(margin, rect.left - subW)
  // 默认顶部对齐；下边缘放不下上移
  let y = rect.top
  if (y + subH + margin > window.innerHeight)
    y = Math.max(margin, window.innerHeight - subH - margin)
  submenuPosition.value = { x, y }
}

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

/** items 变了（如「打开方式」懒加载后填充 children）：若二级菜单正开着要重新定位 */
watch(
  () => props.items,
  async () => {
    if (openParentKey.value && submenuParent.value) {
      // 同步 submenuItems 到最新的 children
      const fresh = props.items.find((i) => i.key === openParentKey.value)
      submenuItems.value = fresh?.children ?? []
      await nextTick()
      positionSubmenu()
    }
  },
  { deep: true },
)

function onSelect(item: ContextMenuItem): void {
  if (item.disabled) return
  // 带 children 的父条目点击不触发动作（只展开二级菜单）
  if (item.children) return
  emit('select', item.key)
  emit('close')
}

function onSubmenuSelect(child: ContextMenuItem): void {
  if (child.disabled) return
  const parentKey = openParentKey.value
  // 回传 `父key/子key` 形式，调用方据此分发
  emit('select', parentKey ? `${parentKey}/${child.key}` : child.key)
  emit('close')
}

/**
 * 点击外部关闭——capture 阶段监听，且 mousedown 而非 click：
 * 用户在菜单外按下鼠标的瞬间就该收起，等到 click（mouseup）会让菜单在拖动
 * 选择文字之类的操作中挂着不动。
 */
function onPointerDownOutside(e: MouseEvent): void {
  const target = e.target as Node
  if (menuEl.value?.contains(target)) return
  if (submenuEl.value?.contains(target)) return
  emit('close')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (openParentKey.value) closeSubmenu()
    else emit('close')
  }
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
  clearHoverTimer()
  document.removeEventListener('mousedown', onPointerDownOutside, true)
  document.removeEventListener('contextmenu', onPointerDownOutside, true)
  document.removeEventListener('keydown', onKeydown)
  window.removeEventListener('scroll', close, true)
  window.removeEventListener('resize', close)
})
</script>
