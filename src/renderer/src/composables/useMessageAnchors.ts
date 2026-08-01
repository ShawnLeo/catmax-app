import {
  inject,
  type InjectionKey,
  onScopeDispose,
  type ObjectDirective,
  readonly,
  type Ref,
  ref,
  watch,
} from 'vue'

const ACTIVATION_OFFSET = 12
const BOTTOM_TOLERANCE = 1

export interface MessageAnchorApi {
  activeId: Readonly<Ref<string | null>>
  register: (id: string, el: HTMLElement) => void
  unregister: (id: string, el?: HTMLElement) => void
  scrollToMessage: (id: string) => void
  refreshActive: () => void
}

export const MESSAGE_ANCHOR_KEY: InjectionKey<MessageAnchorApi> = Symbol('message-anchor')

/** Session Nav Rail: coordinate renderer-owned user-message elements inside one scroll lane. */
export function useMessageAnchors(
  scrollContainer: Ref<HTMLElement | null>,
  sessionId?: Ref<string | null>,
): MessageAnchorApi {
  const anchors = new Map<string, HTMLElement>()
  const activeId = ref<string | null>(null)
  let observedContainer: HTMLElement | null = null
  let refreshFrame: number | null = null

  function cancelScheduledRefresh(): void {
    if (refreshFrame === null) return
    cancelAnimationFrame(refreshFrame)
    refreshFrame = null
  }

  function refreshActive(): void {
    cancelScheduledRefresh()
    const container = scrollContainer.value
    if (!container || anchors.size === 0) {
      activeId.value = null
      return
    }

    const positions = [...anchors].map(([id, el]) => ({
      id,
      top: el.getBoundingClientRect().top,
    }))
    positions.sort((left, right) => left.top - right.top)

    const atBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <= BOTTOM_TOLERANCE
    if (atBottom) {
      activeId.value = positions.at(-1)?.id ?? null
      return
    }

    const activationLine = container.getBoundingClientRect().top + ACTIVATION_OFFSET
    let nextId = positions[0]?.id ?? null
    for (const position of positions) {
      if (position.top > activationLine) break
      nextId = position.id
    }
    activeId.value = nextId
  }

  function scheduleRefresh(): void {
    if (refreshFrame !== null) return
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = null
      refreshActive()
    })
  }

  function register(id: string, el: HTMLElement): void {
    anchors.set(id, el)
    scheduleRefresh()
  }

  function unregister(id: string, el?: HTMLElement): void {
    const registered = anchors.get(id)
    if (!registered || (el && registered !== el)) return
    anchors.delete(id)
    if (activeId.value === id) activeId.value = null
    scheduleRefresh()
  }

  function scrollToMessage(id: string): void {
    const el = anchors.get(id)
    if (!el) return
    activeId.value = id
    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
  }

  function detachContainer(): void {
    observedContainer?.removeEventListener('scroll', scheduleRefresh)
    observedContainer = null
  }

  watch(
    scrollContainer,
    (container) => {
      detachContainer()
      observedContainer = container
      observedContainer?.addEventListener('scroll', scheduleRefresh, { passive: true })
      scheduleRefresh()
    },
    { flush: 'post', immediate: true },
  )

  if (sessionId) {
    watch(
      sessionId,
      () => {
        cancelScheduledRefresh()
        anchors.clear()
        activeId.value = null
      },
      { flush: 'sync' },
    )
  }

  onScopeDispose(() => {
    detachContainer()
    cancelScheduledRefresh()
    anchors.clear()
  })

  return {
    activeId: readonly(activeId),
    refreshActive,
    register,
    scrollToMessage,
    unregister,
  }
}

/** Session Nav Rail: renderer-agnostic local directive for registering a message root. */
export function useMessageAnchorDirective(): ObjectDirective<HTMLElement, string | null> {
  const api = inject(MESSAGE_ANCHOR_KEY, null)

  return {
    mounted(el, binding) {
      if (binding.value) api?.register(binding.value, el)
    },
    updated(el, binding) {
      if (binding.oldValue && binding.oldValue !== binding.value) {
        api?.unregister(binding.oldValue, el)
      }
      if (binding.value) api?.register(binding.value, el)
    },
    unmounted(el, binding) {
      if (binding.value) api?.unregister(binding.value, el)
    },
  }
}
