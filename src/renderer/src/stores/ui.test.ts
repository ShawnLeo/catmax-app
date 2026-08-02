import { appSettingsSchema, PANEL_SIZE_LIMITS } from '@shared/settings-schema'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, test } from 'vitest'

import { useUiStore } from './ui'

describe('ui store panel sizes', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('opens the files tab by default', () => {
    const store = useUiStore()

    expect(store.rightPanelTab).toBe('files')
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

  test('clamps panel dimensions to the persisted range', () => {
    const store = useUiStore()
    store.startPanelDrag()

    // 拖拽上限是按容器算的，可能超出 settings schema 允许的范围——越界的值写进去
    // 会在 settings.update 时被 Zod 打回（主进程刷 ZodError，宽度存不进去）。
    store.setSidebarWidth(PANEL_SIZE_LIMITS.sidebarWidth.max + 500)
    store.setRightPanelWidth(PANEL_SIZE_LIMITS.rightPanelWidth.max + 500)
    store.setBottomPanelHeight(PANEL_SIZE_LIMITS.bottomPanelHeight.min - 50)

    expect(store.sidebarWidth).toBe(PANEL_SIZE_LIMITS.sidebarWidth.max)
    expect(store.rightPanelWidth).toBe(PANEL_SIZE_LIMITS.rightPanelWidth.max)
    expect(store.bottomPanelHeight).toBe(PANEL_SIZE_LIMITS.bottomPanelHeight.min)

    expect(() =>
      appSettingsSchema.parse({
        sidebarWidth: store.sidebarWidth,
        rightPanelWidth: store.rightPanelWidth,
        bottomPanelHeight: store.bottomPanelHeight,
      }),
    ).not.toThrow()
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

  test('toggleSidebar bumps the toggle seq (lets outside-close tell toggle-button from chat clicks)', () => {
    const store = useUiStore()
    // Sidebar Overlay: 窄窗口浮层形态下点聊天区收起侧栏，但顶栏切换按钮自己也会翻转
    // 侧栏——靠 seq 区分"这次点击是切换按钮"和"点的是聊天区空白"。
    const before = store.sidebarToggleSeq
    store.toggleSidebar()
    expect(store.sidebarToggleSeq).toBe(before + 1)
  })
})
