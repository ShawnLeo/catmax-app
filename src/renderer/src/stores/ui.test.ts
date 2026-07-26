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
