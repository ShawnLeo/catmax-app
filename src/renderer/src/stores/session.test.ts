import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { reactive } from 'vue'

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

  test('创建会话前将响应式工作区目录转换为 IPC 可克隆对象', async () => {
    const create = vi.fn((args: unknown) => {
      structuredClone(args)
      return Promise.resolve({ sessionId: 'session-1' })
    })
    const list = vi.fn().mockResolvedValue([])
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { session: { create, list } },
    })
    const workspaceFolders = reactive([
      { id: 'primary', path: '/code/app', alias: 'app', role: 'primary' as const },
      { id: 'secondary', path: '/code/docs', alias: 'docs', role: 'secondary' as const },
    ])

    await useSessionStore().create({
      workspaceId: 'workspace-1',
      cwd: '/code/app',
      workspaceFolders,
      backend: 'codex',
    })

    expect(create).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      cwd: '/code/app',
      workspaceFolders: [
        { id: 'primary', path: '/code/app', alias: 'app', role: 'primary' },
        { id: 'secondary', path: '/code/docs', alias: 'docs', role: 'secondary' },
      ],
      backend: 'codex',
    })
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

  test('按新后端加载列表时同步清空不属于新列表的当前会话和消息视图', async () => {
    const list = vi.fn().mockResolvedValue([
      {
        id: 'codex-session',
        backend: 'codex',
      },
    ])
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { session: { list } },
    })
    const messageStore = useMessageStore()
    const sessionStore = useSessionStore()
    sessionStore.setCurrent('claude-session')
    messageStore.setCurrentSession('claude-session')
    messageStore.pushUserMessageToSession('claude-session', 'turn-1', '旧会话消息')

    await sessionStore.load('workspace-1', 'codex')

    expect(list).toHaveBeenCalledWith({ workspaceId: 'workspace-1', backend: 'codex' })
    expect(sessionStore.currentSessionId).toBeNull()
    expect(messageStore.currentSessionId).toBeNull()
    expect(messageStore.messages).toEqual([])
  })

  test('新建会话状态下 load 不递增 selectionVersion（setCurrent("") 归一化为 null）', async () => {
    const list = vi.fn().mockResolvedValue([
      { id: 'session-1', backend: 'codex' },
      { id: 'session-2', backend: 'codex' },
    ])
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { session: { list } },
    })

    const sessionStore = useSessionStore()

    // 模拟用户点"新建会话"按钮：setCurrent('') 将 currentSessionId 归一化为 null
    sessionStore.setCurrent('')
    const versionBeforeLoad = sessionStore.selectionVersion
    expect(sessionStore.currentSessionId).toBeNull()

    // create() 内部会调 load() 刷新列表；load 不应把 '' 当作"丢失的选择"而递增版本
    await sessionStore.load('workspace-1', 'codex')

    expect(sessionStore.selectionVersion).toBe(versionBeforeLoad)
  })
})
