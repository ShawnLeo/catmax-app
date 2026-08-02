import { useUiStore } from '@renderer/stores/ui'
import { computed, onBeforeUnmount, type Ref, ref, watch } from 'vue'

/**
 * Sidebar Overlay: 窗口不够宽时，侧栏从「停靠」切成「浮层」。
 *
 * 停靠形态里侧栏和主聊天区并排，侧栏越宽聊天区越窄；窗口本来就小的时候这等于
 * 拿正文的可读性换侧栏。浮层形态下侧栏绝对定位浮在聊天区之上，不占布局宽度，
 * 聊天区保持全宽。跟右栏的 useRightPanelOverlay 是一对镜像，判断方式也一致。
 *
 * 切换按「聊天区还剩多少」判断，而不是固定的窗口断点——侧栏展开后聊天区宽度
 * = 容器 - 侧栏宽度，低于舒适下限就不该再让侧栏挤占正文。
 *
 * 这个谓词只依赖窗口宽度、侧栏宽度，两者都不会因为「切成了浮层」而改变，
 * 所以不会在两种形态之间来回抖动。
 */

/**
 * 主聊天区的舒适宽度下限——低于它就不该再让侧栏挤占正文。
 *
 * 复用消息导航侧轨的显示阈值：低于这个宽度聊天区本身已经开始降级（侧轨隐藏），
 * 再挤下去就只剩一条能塞下输入框的窄缝了。跟右栏用同一个数。
 */
const CHAT_AREA_COMFORT = 640

export function useSidebarOverlay(options: {
  /** ChatView 容器宽度 */
  containerWidth: Ref<number>
}): {
  overlayMode: Ref<boolean>
  overlayRef: Ref<HTMLElement | null>
} {
  const uiStore = useUiStore()
  const overlayRef = ref<HTMLElement | null>(null)

  const shouldOverlay = computed(() => {
    // 右栏不参与这里的计算——它在窄窗口下自己走浮层，不再占布局宽度。
    return options.containerWidth.value - uiStore.sidebarWidth < CHAT_AREA_COMFORT
  })

  const overlayMode = ref(shouldOverlay.value)
  watch(shouldOverlay, (next) => {
    overlayMode.value = next
  })

  // ===== 抽屉式收起：点侧栏以外的地方 / Esc =====
  // 注意：peek（hover 临时划出）有自己的一套收回逻辑（useSidebarPeek），不在这里管；
  // 这里只处理「窄窗口下展开成浮层」这种持久形态。两者互斥——peek 只在折叠态发生，
  // overlay 展开态 sidebarCollapsed=false，不会同时活跃。

  /**
   * 这次点击落在侧栏浮层外面吗？
   *
   * 有两类"外面"不算数（跟右栏 overlay 同构）：
   * - 命令面板：盖在所有东西之上的模态。
   * - Teleport 到 body 的浮层（右键菜单、工作区下拉、对话框）：DOM 上在 #app 之外，
   *   但它们是从侧栏里弹出来的，点上去仍属于"在侧栏里操作"。
   */
  function isOutsideClick(target: HTMLElement | null): boolean {
    if (!target) return false
    if (overlayRef.value?.contains(target)) return false
    if (uiStore.commandPaletteVisible) return false
    if (target.closest('#app') === null) return false
    return true
  }

  // 捕获阶段先记下这次点击开始时的状态，冒泡阶段（顶栏切换按钮自己的 click 跑完之后）
  // 再决定收不收——用户点的可能正是顶栏「切换侧栏」按钮（它也在侧栏外面，自己会折叠
  // 侧栏）。用序号而不是 sidebarCollapsed 判断：用户点切换按钮时它先把 collapsed 翻成
  // true，冒泡阶段看到的就是 true，分不出"这次点击把它收了"和"它本来就该收"。
  let pendingClose = false
  let toggleSeqAtPress = 0

  function onClickCapture(e: MouseEvent): void {
    pendingClose = isOutsideClick(e.target as HTMLElement | null)
    toggleSeqAtPress = uiStore.sidebarToggleSeq
  }

  function onClick(): void {
    if (!pendingClose) return
    pendingClose = false
    // 用户点的正是切换按钮——它自己已经翻转了 sidebarCollapsed，不要重复操作。
    if (uiStore.sidebarToggleSeq !== toggleSeqAtPress) return
    uiStore.toggleSidebar()
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && !uiStore.commandPaletteVisible) uiStore.toggleSidebar()
  }

  function detach(): void {
    document.removeEventListener('click', onClickCapture, true)
    document.removeEventListener('click', onClick)
    document.removeEventListener('keydown', onKeydown)
    pendingClose = false
  }

  // 浮层形态 + 侧栏展开时挂监听；其它情况下不占全局事件。
  // immediate: 组件挂载时若已是「窄窗口 + 展开」态（sidebarCollapsed 默认 false），
  // watch 不会因初次求值触发，监听器就漏挂了——outside-close 失效。
  watch(
    () => overlayMode.value && !uiStore.sidebarCollapsed,
    (active) => {
      if (active) {
        document.addEventListener('click', onClickCapture, true)
        document.addEventListener('click', onClick)
        document.addEventListener('keydown', onKeydown)
      } else {
        detach()
      }
    },
    { immediate: true },
  )

  onBeforeUnmount(detach)

  return { overlayMode, overlayRef }
}
