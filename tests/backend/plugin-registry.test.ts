import {
  clearBackendPluginsForTest,
  getBackendPlugins,
  registerBackendPlugin,
} from '@main/backend/plugin-registry'
import type { BackendPluginManifest } from '@shared/backend/plugin'
import { afterEach, describe, expect, test } from 'vitest'

const manifest: BackendPluginManifest = {
  id: 'acme.demo',
  displayName: 'Demo backend',
  version: '1.0.0',
  blockTypes: ['text'],
  capabilities: {
    supportsInterrupt: true,
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
      blockTypes: ['text'],
    },
  },
}

afterEach(() => clearBackendPluginsForTest())

describe('backend plugin registry', () => {
  test('registers a namespaced backend plugin', () => {
    registerBackendPlugin({
      manifest,
      createAdapter: () => {
        throw new Error('not needed by registry test')
      },
    })
    expect(getBackendPlugins().map((plugin) => plugin.manifest.id)).toEqual(['acme.demo'])
  })

  test('rejects duplicate ids', () => {
    const plugin = {
      manifest,
      createAdapter: () => {
        throw new Error('not needed by registry test')
      },
    }
    registerBackendPlugin(plugin)
    expect(() => registerBackendPlugin(plugin)).toThrow('already registered')
  })

  test('rejects unsafe ids', () => {
    expect(() =>
      registerBackendPlugin({
        manifest: { ...manifest, id: '../demo' },
        createAdapter: () => {
          throw new Error('not needed by registry test')
        },
      }),
    ).toThrow('invalid backend plugin id')
  })
})
