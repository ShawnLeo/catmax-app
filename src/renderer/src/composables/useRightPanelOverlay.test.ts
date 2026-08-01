import { useUiStore } from '@renderer/stores/ui'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { defineComponent, h, nextTick, type Ref, ref } from 'vue'

import { useRightPanelOverlay } from './useRightPanelOverlay'

/**
 * 宿主组件：把 composable 装进一个真实的 #app 子树里，
 * 让"点面板外面收起"能按真实的 DOM 层级和事件传播来验证。
 */
function mountHarness(
  containerWidth: Ref<number>,
  desiredWidth: Ref<number>,
): {
  wrapper: VueWrapper
  overlayMode: Ref<boolean>
  chat: HTMLElement
} {
  let overlayMode!: Ref<boolean>
  const wrapper = mount(
    defineComponent({
      setup() {
        const api = useRightPanelOverlay({ containerWidth, desiredWidth })
        overlayMode = api.overlayMode
        return () =>
          h('div', { id: 'app' }, [
            h('div', { ref: api.overlayRef, id: 'panel' }, '面板'),
            h('div', { id: 'chat' }, '聊天区'),
          ])
      },
    }),
    { attachTo: document.body },
  )
  return { wrapper, overlayMode, chat: wrapper.get('#chat').element as HTMLElement }
}

describe('useRightPanelOverlay 形态切换', () => {
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
    const desiredWidth = ref(320)
    const harness = mountHarness(containerWidth, desiredWidth)
    wrapper = harness.wrapper

    // 1400 - 240(侧栏) - 320(面板) = 840，聊天区够宽
    expect(harness.overlayMode.value).toBe(false)

    containerWidth.value = 1000
    await nextTick()
    // 1000 - 240 - 320 = 440，低于聊天区舒适宽度
    expect(harness.overlayMode.value).toBe(true)
  })

  test('同一窗口宽度下，宽面板会浮层化而窄面板仍停靠', async () => {
    const containerWidth = ref(1280)
    const desiredWidth = ref(320)
    const harness = mountHarness(containerWidth, desiredWidth)
    wrapper = harness.wrapper

    expect(harness.overlayMode.value).toBe(false)

    // 切到审查 tab 那种被撑宽的面板
    desiredWidth.value = 760
    await nextTick()
    expect(harness.overlayMode.value).toBe(true)
  })

  test('拖拽分隔条期间冻结形态，松手后才结算', async () => {
    const containerWidth = ref(1400)
    const desiredWidth = ref(320)
    const harness = mountHarness(containerWidth, desiredWidth)
    wrapper = harness.wrapper
    const ui = useUiStore()

    ui.startPanelDrag()
    desiredWidth.value = 900
    await nextTick()
    // 手还按着——布局不该在这一刻跳变
    expect(harness.overlayMode.value).toBe(false)

    ui.endPanelDrag()
    await nextTick()
    expect(harness.overlayMode.value).toBe(true)
  })
})

describe('useRightPanelOverlay 抽屉式收起', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  async function mountOverlayOpen(): Promise<{
    chat: HTMLElement
    ui: ReturnType<typeof useUiStore>
  }> {
    const harness = mountHarness(ref(900), ref(320))
    wrapper = harness.wrapper
    const ui = useUiStore()
    expect(harness.overlayMode.value).toBe(true)
    ui.showRightPanel('git')
    await nextTick()
    return { chat: harness.chat, ui }
  }

  test('点面板外面收起', async () => {
    const { chat, ui } = await mountOverlayOpen()

    chat.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(ui.rightPanelVisible).toBe(false)
  })

  test('点的是"打开面板"的入口时不收起', async () => {
    const { chat, ui } = await mountOverlayOpen()

    // 模拟消息流里的「审查」入口：它在面板外面，但这次点击的意图是打开面板
    chat.addEventListener('click', () => ui.showRightPanel('review'))
    chat.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(ui.rightPanelVisible).toBe(true)
    expect(ui.rightPanelTab).toBe('review')
  })

  test('Esc 收起', async () => {
    const { ui } = await mountOverlayOpen()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(ui.rightPanelVisible).toBe(false)
  })

  test('停靠形态下点聊天区不收起', async () => {
    const harness = mountHarness(ref(1400), ref(320))
    wrapper = harness.wrapper
    const ui = useUiStore()
    ui.showRightPanel('git')
    await nextTick()

    harness.chat.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(ui.rightPanelVisible).toBe(true)
  })
})
