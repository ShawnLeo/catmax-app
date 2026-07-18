import { describe, expect, test, vi } from 'vitest'

// mock electron 模块（避免在 node 测试环境真的 import）
vi.mock('electron', () => {
  const handlers = new Map<string, Function>()
  const listeners = new Map<string, Set<Function>>()
  return {
    ipcMain: {
      eventNames: () => Array.from(handlers.keys()),
      handle: (channel: string, fn: Function) => handlers.set(channel, fn),
      removeHandler: (channel: string) => handlers.delete(channel),
    },
    ipcRenderer: {
      invoke: vi.fn(),
      on: (channel: string, fn: Function) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set())
        listeners.get(channel)!.add(fn)
      },
      removeListener: (channel: string, fn: Function) => {
        listeners.get(channel)?.delete(fn)
      },
    },
  }
})

// 必须在 mock 之后 import
const { handleRendererRequest } = await import('@main/ipc/typed')

describe('typed IPC', () => {
  test('重复注册同一 channel 抛错', () => {
    const handler = () => 'ok'
    handleRendererRequest('test.channel1', handler)
    expect(() => handleRendererRequest('test.channel1', handler)).toThrow(/already registered/)
  })

  test('不同 channel 不冲突', () => {
    handleRendererRequest('test.channel2', () => 1)
    handleRendererRequest('test.channel3', () => 2)
    // 不抛错即通过
  })
})
