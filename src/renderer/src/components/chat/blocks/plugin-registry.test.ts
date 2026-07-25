import type { BackendCapabilities } from '@shared/backend/types'
import { afterEach, describe, expect, test } from 'vitest'

import {
  clearRendererBackendPluginsForTest,
  getBackendConversationRenderer,
  registerRendererBackendBlocks,
  registerRendererBackendPlugin,
} from './plugin-registry'
import { clearBlockRegistry, isBlockRegistered, registerBlock } from './registry'

const capabilities: BackendCapabilities = {
  supportsInterrupt: false,
  supportsApproval: false,
  supportsSteer: false,
  supportsThreadFork: false,
  supportsModelSelection: false,
  supportsEffort: false,
  supportsPermissionMode: false,
  supportedPermissionModes: [],
  supportedEfforts: [],
  supportsHotSwap: false,
  chat: {
    subAgents: false,
    compact: false,
    planMode: false,
    webTools: false,
    blockTypes: ['acme.progress'],
  },
}

afterEach(() => {
  clearRendererBackendPluginsForTest()
  clearBlockRegistry()
})

describe('renderer backend plugin registry', () => {
  test('runs the plugin block registration hook', () => {
    registerRendererBackendPlugin({
      manifest: {
        id: 'acme.demo',
        displayName: 'Demo',
        version: '1',
        blockTypes: ['acme.progress'],
        capabilities,
      },
      registerBlocks: () => {
        registerBlock('acme.progress', async () => ({ default: {} }))
      },
    })

    registerRendererBackendBlocks()
    expect(isBlockRegistered('acme.progress')).toBe(true)
  })

  test('registers an optional backend conversation composition root', () => {
    registerRendererBackendPlugin({
      manifest: {
        id: 'acme.demo',
        displayName: 'Demo',
        version: '1',
        blockTypes: ['acme.progress'],
        capabilities,
      },
      registerBlocks: () => {
        registerBlock('acme.progress', async () => ({ default: {} }))
      },
      conversationRenderer: async () => ({ default: {} }),
    })

    expect(getBackendConversationRenderer('acme.demo')).not.toBeNull()
  })
})
