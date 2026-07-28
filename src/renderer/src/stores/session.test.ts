import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { useMessageStore } from './message'
import { useSessionStore } from './session'

describe('session store selection version', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('每次切换会话都递增版本，让异步创建识别过期选择', () => {
    const store = useSessionStore()

    expect(store.selectionVersion).toBe(0)
    store.setCurrent('session-1')
    expect(store.selectionVersion).toBe(1)
    store.setCurrent('')
    expect(store.selectionVersion).toBe(2)
  })

  test('已有实时消息的新 thread 切换时不读取尚未物化的历史', async () => {
    const detail = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { session: { detail } },
    })
    const messageStore = useMessageStore()
    const sessionStore = useSessionStore()
    messageStore.pushUserMessageToSession('session-pending', 'turn-1', '你好')

    await sessionStore.loadHistory('session-pending')

    expect(detail).not.toHaveBeenCalled()
    messageStore.setCurrentSession('session-pending')
    expect(messageStore.messages[0]?.blocks?.[0]).toMatchObject({ text: '你好' })
  })
})
