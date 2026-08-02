import { useUiStore } from '@renderer/stores/ui'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { defineComponent, h, nextTick, type Ref, ref } from 'vue'

import { useSidebarOverlay } from './useSidebarOverlay'

/**
 * 宿主组件：把 composable 装进一个真实的 #app 子树里，
 * 让"点侧栏外面收起"能按真实的 DOM 层级和事件传播来验证。
 */
function mountHarness(containerWidth: Ref<number>): {
  wrapper: VueWrapper
  overlayMode: Ref<boolean>
  chat: HTMLElement
} {
  let overlayMode!: Ref<boolean>
  const wrapper = mount(
    defineComponent({
      setup() {
        const api = useSidebarOverlay({ containerWidth })
        overlayMode = api.overlayMode
        return () =>
          h('div', { id: 'app' }, [
            h('div', { ref: api.overlayRef, id: 'sidebar' }, '侧栏'),
            h('div', { id: 'chat' }, '聊天区'),
          ])
      },
    }),
    { attachTo: document.body },
  )
  return { wrapper, overlayMode, chat: wrapper.get('#chat').element as HTMLElement }
}

describe('useSidebarOverlay 形态切换', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  test('聊天区还够宽时停靠，不够宽时切成浮层', async () => {
    const containerWidth = ref(1400)
    const harness = mountHarness(containerWidth)
    wrapper = harness.wrapper

    // 1400 - 240(侧栏) = 1160，聊天区够宽
    expect(harness.overlayMode.value).toBe(false)

    containerWidth.value = 800
    await nextTick()
    // 800 - 240 = 560，低于聊天区舒适宽度
    expect(harness.overlayMode.value).toBe(true)
  })
})

describe('useSidebarOverlay 抽屉式收起', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  async function mountOverlayExpanded(): Promise<{
    chat: HTMLElement
    ui: ReturnType<typeof useUiStore>
  }> {
    const harness = mountHarness(ref(800))
    wrapper = harness.wrapper
    const ui = useUiStore()
    expect(harness.overlayMode.value).toBe(true)
    // sidebarCollapsed 默认 false（展开）——窄窗口浮层形态下浮层因此显示。
    expect(ui.sidebarCollapsed).toBe(false)
    await nextTick()
    return { chat: harness.chat, ui }
  }

  test('点侧栏外面收起', async () => {
    const { chat, ui } = await mountOverlayExpanded()

    chat.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(ui.sidebarCollapsed).toBe(true)
  })

  test('Esc 收起', async () => {
    const { ui } = await mountOverlayExpanded()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(ui.sidebarCollapsed).toBe(true)
  })

  test('停靠形态下点聊天区不收起侧栏', async () => {
    const harness = mountHarness(ref(1400))
    wrapper = harness.wrapper
    const ui = useUiStore()
    // 宽窗口停靠形态，侧栏展开（collapsed=false）
    expect(ui.sidebarCollapsed).toBe(false)

    harness.chat.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    // 停靠形态下 outside-close 监听没挂，点聊天区不该翻转侧栏状态
    expect(ui.sidebarCollapsed).toBe(false)
  })
})
