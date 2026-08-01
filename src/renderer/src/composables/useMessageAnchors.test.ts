import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'

import { useMessageAnchors } from './useMessageAnchors'

function setRect(element: HTMLElement, top: number): void {
  element.getBoundingClientRect = vi.fn(() => ({
    bottom: top + 20,
    height: 20,
    left: 0,
    right: 100,
    toJSON: () => ({}),
    top,
    width: 100,
    x: 0,
    y: top,
  }))
}

function setScrollMetrics(
  container: HTMLElement,
  metrics: { clientHeight: number; scrollHeight: number; scrollTop: number },
): void {
  Object.defineProperties(container, {
    clientHeight: { configurable: true, value: metrics.clientHeight },
    scrollHeight: { configurable: true, value: metrics.scrollHeight },
    scrollTop: { configurable: true, value: metrics.scrollTop, writable: true },
  })
}

describe('useMessageAnchors', () => {
  let frameId = 0

  beforeEach(() => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => ++frameId),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('selects the last anchor that crossed the activation line', () => {
    const container = document.createElement('div')
    setRect(container, 100)
    setScrollMetrics(container, { clientHeight: 400, scrollHeight: 1000, scrollTop: 200 })

    const first = document.createElement('article')
    const second = document.createElement('article')
    const third = document.createElement('article')
    setRect(first, 20)
    setRect(second, 110)
    setRect(third, 260)

    const scope = effectScope()
    const api = scope.run(() => useMessageAnchors(ref(container)))!
    api.register('first', first)
    api.register('second', second)
    api.register('third', third)
    api.refreshActive()

    expect(api.activeId.value).toBe('second')
    scope.stop()
  })

  test('selects the final anchor when the container reaches the bottom', () => {
    const container = document.createElement('div')
    setRect(container, 0)
    setScrollMetrics(container, { clientHeight: 400, scrollHeight: 1000, scrollTop: 600 })

    const first = document.createElement('article')
    const last = document.createElement('article')
    setRect(first, -300)
    setRect(last, 300)

    const scope = effectScope()
    const api = scope.run(() => useMessageAnchors(ref(container)))!
    api.register('first', first)
    api.register('last', last)
    api.refreshActive()

    expect(api.activeId.value).toBe('last')
    scope.stop()
  })

  test('does not let an old element unregister its replacement', () => {
    const container = document.createElement('div')
    setRect(container, 0)
    setScrollMetrics(container, { clientHeight: 100, scrollHeight: 500, scrollTop: 0 })
    const oldElement = document.createElement('article')
    const replacement = document.createElement('article')
    replacement.scrollIntoView = vi.fn()

    const scope = effectScope()
    const api = scope.run(() => useMessageAnchors(ref(container)))!
    api.register('same-id', oldElement)
    api.register('same-id', replacement)
    api.unregister('same-id', oldElement)
    api.scrollToMessage('same-id')

    expect(replacement.scrollIntoView).toHaveBeenCalledOnce()
    scope.stop()
  })

  test('updates active immediately and respects reduced-motion preferences', () => {
    const container = document.createElement('div')
    const anchor = document.createElement('article')
    anchor.scrollIntoView = vi.fn()
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })

    const scope = effectScope()
    const api = scope.run(() => useMessageAnchors(ref(container)))!
    api.register('target', anchor)
    api.scrollToMessage('target')

    expect(api.activeId.value).toBe('target')
    expect(anchor.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' })
    scope.stop()
  })

  test('clears stale anchors when the session changes', async () => {
    const container = document.createElement('div')
    const anchor = document.createElement('article')
    anchor.scrollIntoView = vi.fn()
    const sessionId = ref<string | null>('session-a')

    const scope = effectScope()
    const api = scope.run(() => useMessageAnchors(ref(container), sessionId))!
    api.register('old-message', anchor)
    api.scrollToMessage('old-message')
    expect(api.activeId.value).toBe('old-message')

    sessionId.value = 'session-b'
    await nextTick()
    api.scrollToMessage('old-message')

    expect(api.activeId.value).toBeNull()
    expect(anchor.scrollIntoView).toHaveBeenCalledOnce()
    scope.stop()
  })

  test('removes the scroll listener when its scope is disposed', async () => {
    const container = document.createElement('div')
    const addEventListener = vi.spyOn(container, 'addEventListener')
    const removeEventListener = vi.spyOn(container, 'removeEventListener')

    const scope = effectScope()
    scope.run(() => useMessageAnchors(ref(container)))
    await nextTick()
    expect(addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function), {
      passive: true,
    })

    scope.stop()
    expect(removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function))
  })
})
