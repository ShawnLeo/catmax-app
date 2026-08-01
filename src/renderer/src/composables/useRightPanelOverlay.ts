import { MIN_WIDTH_FOR_MESSAGE_NAV_RAIL } from '@renderer/lib/chat-layout'
import { useUiStore } from '@renderer/stores/ui'
import { computed, onBeforeUnmount, type Ref, ref, watch } from 'vue'

/**
 * Right Panel Overlay: 窗口不够宽时，右栏从「停靠」切成「浮层」。
 *
 * 停靠形态里右栏和主聊天区并排，面板越宽聊天区越窄；窗口本来就小的时候这等于
 * 拿正文的可读性换面板。浮层形态下右栏绝对定位浮在聊天区之上，不占布局宽度，
 * 聊天区保持全宽。
 *
 * 切换按「聊天区还剩多少」判断，而不是固定的窗口断点——右栏各 tab 的宽度差距很大
 * （Git 320，审查 760，文件+预览 900+），同一个窗口宽度下开 Git 完全够用、开审查
 * 必然挤爆，固定断点区分不了这两种情况。
 *
 * 这个谓词只依赖窗口宽度、侧栏宽度、面板期望宽度，三者都不会因为「切成了浮层」
 * 而改变，所以不会在两种形态之间来回抖动。
 */

/**
 * 主聊天区的舒适宽度下限——低于它就不该再让右栏挤占正文。
 *
 * 复用消息导航侧轨的显示阈值：低于这个宽度聊天区本身已经开始降级（侧轨隐藏），
 * 再挤下去就只剩一条能塞下输入框的窄缝了。
 */
const CHAT_AREA_COMFORT = MIN_WIDTH_FOR_MESSAGE_NAV_RAIL

/** 浮层最宽占窗口的比例——留一条边让用户看得见聊天区，也点得到（点外部收起）。 */
const OVERLAY_MAX_RATIO = 0.85

export function useRightPanelOverlay(options: {
  /** ChatView 容器宽度 */
  containerWidth: Ref<number>
  /** 右栏期望占据的宽度（含文件预览分栏，即 rightPanelCurrent） */
  desiredWidth: Ref<number>
}): {
  overlayMode: Ref<boolean>
  overlayRef: Ref<HTMLElement | null>
  overlayMaxWidth: Ref<number>
} {
  const uiStore = useUiStore()
  const overlayRef = ref<HTMLElement | null>(null)

  const shouldOverlay = computed(() => {
    const sidebarWidth = uiStore.sidebarCollapsed ? 0 : uiStore.sidebarWidth
    return (
      options.containerWidth.value - sidebarWidth - options.desiredWidth.value < CHAT_AREA_COMFORT
    )
  })

  // 拖拽分隔条期间冻结形态：拖到阈值那一刻整个布局会跳一下（聊天区突然回到全宽），
  // 在手还按着的时候发生非常突兀。松手后再结算。
  const overlayMode = ref(shouldOverlay.value)
  watch([shouldOverlay, () => uiStore.panelDragging], ([next, dragging]) => {
    if (dragging) return
    overlayMode.value = next
  })

  const overlayMaxWidth = computed(() =>
    Math.floor(options.containerWidth.value * OVERLAY_MAX_RATIO),
  )

  // ===== 抽屉式收起：点面板以外的地方 / Esc =====

  /**
   * 这次点击落在面板外面吗？
   *
   * 有两类"外面"不算数：
   * - 命令面板：盖在所有东西之上的模态，在里面挑命令不是"点了聊天区"。
   * - Teleport 到 body 的浮层（右键菜单、图片预览、对话框）：DOM 上在 #app 之外，
   *   但它们是从面板里弹出来的，点上去仍属于"在这个面板里操作"。
   */
  function isOutsideClick(target: HTMLElement | null): boolean {
    if (!target) return false
    if (overlayRef.value?.contains(target)) return false
    if (uiStore.commandPaletteVisible) return false
    if (target.closest('#app') === null) return false
    return true
  }

  // 捕获阶段先记下这次点击开始时的状态，冒泡阶段（目标自己的 click 处理器跑完之后）
  // 再决定关不关——用户点的可能正是消息流里「审查」「后台任务」这类打开面板的入口，
  // 它们同样在面板外面。用序号而不是 rightPanelVisible 判断：面板本来就开着，
  // 只看显隐分不出"这次点击把它又打开了一遍"。
  let pendingClose = false
  let openSeqAtPress = 0

  function onClickCapture(e: MouseEvent): void {
    pendingClose = isOutsideClick(e.target as HTMLElement | null)
    openSeqAtPress = uiStore.rightPanelOpenSeq
  }

  function onClick(): void {
    if (!pendingClose) return
    pendingClose = false
    if (uiStore.rightPanelOpenSeq !== openSeqAtPress) return
    uiStore.hideRightPanel()
  }

  function onKeydown(e: KeyboardEvent): void {
    // 命令面板开着时 Esc 属于它（关面板），不该顺手把右栏也收了。
    if (e.key === 'Escape' && !uiStore.commandPaletteVisible) uiStore.hideRightPanel()
  }

  function detach(): void {
    document.removeEventListener('click', onClickCapture, true)
    document.removeEventListener('click', onClick)
    document.removeEventListener('keydown', onKeydown)
    pendingClose = false
  }

  watch(
    () => overlayMode.value && uiStore.rightPanelVisible,
    (active) => {
      if (active) {
        document.addEventListener('click', onClickCapture, true)
        document.addEventListener('click', onClick)
        document.addEventListener('keydown', onKeydown)
      } else {
        detach()
      }
    },
  )

  onBeforeUnmount(detach)

  return { overlayMode, overlayRef, overlayMaxWidth }
}
