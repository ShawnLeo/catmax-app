import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, test } from 'vitest'

import { useUiStore } from './ui'

describe('ui store panel sizes', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('normalizes persisted panel dimensions to integer pixels', () => {
    const store = useUiStore()
    store.startPanelDrag()

    store.setSidebarWidth(312.5)
    store.setRightPanelWidth(487.25)
    store.setBottomPanelHeight(245.75)

    expect(store.sidebarWidth).toBe(313)
    expect(store.rightPanelWidth).toBe(487)
    expect(store.bottomPanelHeight).toBe(246)
  })
})

describe('ui store sidebar peek', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('only peeks while the sidebar is collapsed', () => {
    const store = useUiStore()

    // 展开状态下真侧栏就在那儿，划出浮层没有意义
    store.openSidebarPeek()
    expect(store.sidebarPeeking).toBe(false)

    store.toggleSidebar()
    store.openSidebarPeek()
    expect(store.sidebarPeeking).toBe(true)

    store.closeSidebarPeek()
    expect(store.sidebarPeeking).toBe(false)
  })

  test('peek does not change the collapsed state, but toggling clears the peek', () => {
    const store = useUiStore()
    store.toggleSidebar()
    store.openSidebarPeek()

    expect(store.sidebarCollapsed).toBe(true)

    store.toggleSidebar()
    expect(store.sidebarCollapsed).toBe(false)
    expect(store.sidebarPeeking).toBe(false)
  })
})
