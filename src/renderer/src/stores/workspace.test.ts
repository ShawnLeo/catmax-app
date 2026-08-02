import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { reactive } from 'vue'

import { useWorkspaceStore } from './workspace'

const addWorkspace = vi.fn((args: unknown) => {
  // Mirror Electron IPC serialization so a Vue Proxy fails this test before the store boundary fix.
  structuredClone(args)
  return Promise.resolve({
    id: 'workspace-1',
    path: '/code/app',
    name: 'app',
    folders: [],
    preferredEditor: null,
    lastOpenedAt: 1,
    createdAt: 1,
  })
})

describe('workspace store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    addWorkspace.mockClear()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { workspace: { add: addWorkspace } },
    })
  })

  test('converts reactive secondary paths to an IPC-cloneable array', async () => {
    const secondaryPaths = reactive(['/code/docs', '/code/shared'])

    await useWorkspaceStore().add('/code/app', 'app', secondaryPaths)

    const args = addWorkspace.mock.calls[0]?.[0]
    expect(args).toEqual({
      path: '/code/app',
      name: 'app',
      secondaryPaths: ['/code/docs', '/code/shared'],
    })
    expect(structuredClone(args)).toEqual(args)
  })
})
