import { MESSAGE_ANCHOR_KEY, type MessageAnchorApi } from '@renderer/composables/useMessageAnchors'
import type { NormalizedMessage } from '@shared/backend/types'
import { mount } from '@vue/test-utils'
import { describe, expect, test, vi } from 'vitest'
import { ref } from 'vue'

import MessageNavRail from './MessageNavRail.vue'

function userMessage(id: string, text: string): NormalizedMessage {
  return {
    id,
    role: 'user',
    turnId: `turn-${id}`,
    blocks: [{ id: `${id}-text`, type: 'text', text }],
    createdAt: 0,
  }
}

describe('MessageNavRail', () => {
  test('exposes the active location and delegates navigation', async () => {
    const activeId = ref<string | null>('second')
    const scrollToMessage = vi.fn()
    const api: MessageAnchorApi = {
      activeId,
      refreshActive: vi.fn(),
      register: vi.fn(),
      scrollToMessage,
      unregister: vi.fn(),
    }
    const wrapper = mount(MessageNavRail, {
      props: {
        userMessages: [userMessage('first', '第一条消息'), userMessage('second', '第二条消息')],
      },
      global: {
        provide: { [MESSAGE_ANCHOR_KEY as symbol]: api },
      },
    })

    const nav = wrapper.get('nav')
    const buttons = nav.findAll('button')
    expect(buttons).toHaveLength(2)
    expect(buttons[1]!.attributes('aria-current')).toBe('location')
    expect(buttons[1]!.get('span').attributes('style')).toBe('width: 8px;')
    expect(buttons[0]!.attributes('aria-label')).toContain('第一条消息')
    expect(wrapper.findAll('[role="tooltip"]')[0]!.text()).toBe('第一条消息')

    await buttons[0]!.trigger('click')
    expect(scrollToMessage).toHaveBeenCalledWith('first')
  })

  test('builds a proximity staircase around the hovered item', async () => {
    const api: MessageAnchorApi = {
      activeId: ref(null),
      refreshActive: vi.fn(),
      register: vi.fn(),
      scrollToMessage: vi.fn(),
      unregister: vi.fn(),
    }
    const wrapper = mount(MessageNavRail, {
      props: {
        userMessages: [
          userMessage('first', '第一条'),
          userMessage('second', '第二条'),
          userMessage('third', '第三条'),
          userMessage('fourth', '第四条'),
        ],
      },
      global: { provide: { [MESSAGE_ANCHOR_KEY as symbol]: api } },
    })

    const items = wrapper.get('nav').findAll('[data-rail-item]')
    await items[2]!.trigger('mouseenter')
    const widths = items.map((item) => item.get('button > span').attributes('style'))

    expect(widths).toEqual(['width: 13px;', 'width: 18px;', 'width: 24px;', 'width: 18px;'])
  })

  test('shows only one tooltip when focus and hover point at different items', async () => {
    const api: MessageAnchorApi = {
      activeId: ref(null),
      refreshActive: vi.fn(),
      register: vi.fn(),
      scrollToMessage: vi.fn(),
      unregister: vi.fn(),
    }
    const wrapper = mount(MessageNavRail, {
      props: {
        userMessages: [userMessage('first', '第一条消息'), userMessage('second', '第二条消息')],
      },
      global: { provide: { [MESSAGE_ANCHOR_KEY as symbol]: api } },
    })

    const nav = wrapper.get('nav')
    const items = nav.findAll('[data-rail-item]')
    const buttons = nav.findAll('button')
    await buttons[0]!.trigger('focus')
    await items[1]!.trigger('mouseenter')

    const visibleTooltips = wrapper
      .findAll('[role="tooltip"]')
      .filter((tooltip) => tooltip.classes().includes('visible'))
    expect(visibleTooltips).toHaveLength(1)
    expect(visibleTooltips[0]!.text()).toBe('第二条消息')
  })

  test('renders the complete prompt in the tooltip', () => {
    const longPrompt = `第一段\n\n${'很长的消息'.repeat(40)}`
    const api: MessageAnchorApi = {
      activeId: ref(null),
      refreshActive: vi.fn(),
      register: vi.fn(),
      scrollToMessage: vi.fn(),
      unregister: vi.fn(),
    }
    const wrapper = mount(MessageNavRail, {
      props: { userMessages: [userMessage('long', longPrompt)] },
      global: { provide: { [MESSAGE_ANCHOR_KEY as symbol]: api } },
    })

    expect(wrapper.get('[role="tooltip"]').text()).toBe(longPrompt)
  })
})
