import { useUiStore } from '@renderer/stores/ui'
import { onBeforeUnmount, type Ref, ref, watch } from 'vue'

/**
 * Sidebar Peek: 侧栏折叠时，鼠标划到窗口最左边缘临时划出一层浮动侧栏，
 * 指针离开后自动收回（折叠状态本身不变，见 uiStore.sidebarPeeking）。
 *
 * 收回判定不用浮层的 mouseleave——从浮层里弹出的下拉/右键菜单都 Teleport 到 body，
 * 指针移上去时 DOM 上已经离开了浮层子树，会误判成"鼠标移走了"。这里改成按指针
 * 坐标判断，并把 #app 之外的浮层节点也算进 peek 的交互范围。
 */

/** 指针离开后延迟多久收回——擦边划出（经过滚动条、菜单缝隙）不该立刻把面板收掉。 */
const CLOSE_DELAY_MS = 260

export function useSidebarPeek(): {
  peekRef: Ref<HTMLElement | null>
  openPeek: () => void
} {
  const uiStore = useUiStore()
  const peekRef = ref<HTMLElement | null>(null)
  let closeTimer: number | null = null

  function cancelClose(): void {
    if (closeTimer === null) return
    window.clearTimeout(closeTimer)
    closeTimer = null
  }

  function scheduleClose(): void {
    if (closeTimer !== null) return
    closeTimer = window.setTimeout(() => {
      closeTimer = null
      uiStore.closeSidebarPeek()
    }, CLOSE_DELAY_MS)
  }

  function openPeek(): void {
    cancelClose()
    uiStore.openSidebarPeek()
  }

  /**
   * 指针是否仍在 peek 的交互范围内：浮层自身，或它 Teleport 到 body 的浮层
   * （会话右键菜单、工作区下拉、对话框）——这些节点都在 #app 之外。
   */
  function isPointerInsidePeek(x: number, y: number): boolean {
    const el = document.elementFromPoint(x, y)
    if (!el) return false
    if (peekRef.value?.contains(el)) return true
    return el.closest('#app') === null
  }

  function onPointerMove(e: PointerEvent): void {
    if (isPointerInsidePeek(e.clientX, e.clientY)) cancelClose()
    else scheduleClose()
  }

  /** 指针移出窗口后不会再有 pointermove，只能靠这个把面板收回去。 */
  function onWindowPointerOut(e: PointerEvent): void {
    if (e.relatedTarget === null) scheduleClose()
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      cancelClose()
      uiStore.closeSidebarPeek()
    }
  }

  // 监听只在浮层打开期间挂着——折叠状态下 pointermove 是高频事件，不该常驻。
  watch(
    () => uiStore.sidebarPeeking,
    (peeking) => {
      if (peeking) {
        document.addEventListener('pointermove', onPointerMove)
        document.addEventListener('pointerout', onWindowPointerOut)
        document.addEventListener('keydown', onKeydown)
      } else {
        cancelClose()
        document.removeEventListener('pointermove', onPointerMove)
        document.removeEventListener('pointerout', onWindowPointerOut)
        document.removeEventListener('keydown', onKeydown)
      }
    },
  )

  // 侧栏被真正展开时（顶栏按钮 / 快捷键）立即收掉浮层，避免两层侧栏叠在一起。
  watch(
    () => uiStore.sidebarCollapsed,
    (collapsed) => {
      if (!collapsed) {
        cancelClose()
        uiStore.closeSidebarPeek()
      }
    },
  )

  onBeforeUnmount(() => {
    cancelClose()
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerout', onWindowPointerOut)
    document.removeEventListener('keydown', onKeydown)
    uiStore.closeSidebarPeek()
  })

  return { peekRef, openPeek }
}
