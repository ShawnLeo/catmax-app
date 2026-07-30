// @vitest-environment node
//
// 验证 updateSettings 的重连逻辑：开关翻转才重连 codex，纯切 provider 不重连。
// 用 mock 的 ctx + settingsStore + backendManager 隔离真实依赖。
import type { AppSettings } from '@shared/settings-schema'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  applySettings: vi.fn(async () => {}),
  load: vi.fn(),
  update: vi.fn(),
  getCurrentId: vi.fn(() => 'codex'),
  reconnectBackend: vi.fn(async () => {}),
}))

vi.mock('@main/context', () => ({
  ctx: {
    settingsStore: { load: mocks.load, update: mocks.update },
    backendManager: {
      applySettings: mocks.applySettings,
      getCurrentId: mocks.getCurrentId,
      reconnectBackend: mocks.reconnectBackend,
    },
  },
}))

vi.mock('@main/protocol/manager', () => ({
  bridgeManager: { applySettings: vi.fn(async () => {}) },
}))

const { updateSettings } = await import('@main/ipc/domains/settings/handlers')

function settingsWith(enabled: boolean, currentProviderId = 'p1'): AppSettings {
  return {
    defaultBackend: 'codex',
    backendPaths: { codex: null, claude: null },
    defaultRuntimeConfig: { codex: {}, claude: {} },
    protocolBridge: {
      enabled,
      currentProviderId,
      providers: {
        p1: {
          id: 'p1',
          name: 't',
          presetId: 'custom',
          createdAt: 1,
          protocol: 'anthropic.messages',
          baseUrl: 'https://x',
          modelsUrl: '',
          model: null,
          credentialSource: 'stored',
          credentialEnvVar: '',
          capabilities: {
            supportsImages: true,
            dropSamplingWhenThinking: true,
            defaultMaxOutputTokens: 8192,
            toolNameMaxLength: 64,
          },
          modelListMode: 'manual',
          manualModels: [],
        },
      },
    },
    defaultEditor: 'vscode',
    theme: {},
    httpProxy: {},
    language: 'zh-CN',
    sendOnEnter: true,
    showReasoningByDefault: false,
  } as unknown as AppSettings
}

describe('updateSettings 重连条件', () => {
  beforeEach(() => {
    mocks.applySettings.mockClear()
    mocks.reconnectBackend.mockClear()
    mocks.getCurrentId.mockReturnValue('codex')
  })

  test('桥开关翻转（关→开）且当前是 codex → 重连', async () => {
    mocks.load.mockReturnValue(settingsWith(false))
    mocks.update.mockReturnValue(settingsWith(true))
    await updateSettings({ patch: {} })
    expect(mocks.reconnectBackend).toHaveBeenCalledWith('codex')
  })

  test('桥开关翻转（开→关）且当前是 codex → 重连', async () => {
    mocks.load.mockReturnValue(settingsWith(true))
    mocks.update.mockReturnValue(settingsWith(false))
    await updateSettings({ patch: {} })
    expect(mocks.reconnectBackend).toHaveBeenCalledWith('codex')
  })

  test('纯切 provider（enabled 不变）→ 不重连', async () => {
    mocks.load.mockReturnValue(settingsWith(true, 'p1'))
    mocks.update.mockReturnValue(settingsWith(true, 'p2'))
    await updateSettings({ patch: {} })
    expect(mocks.reconnectBackend).not.toHaveBeenCalled()
  })

  test('enabled 不变且改了 provider 字段 → 不重连', async () => {
    mocks.load.mockReturnValue(settingsWith(true, 'p1'))
    mocks.update.mockReturnValue(settingsWith(true, 'p1'))
    await updateSettings({ patch: {} })
    expect(mocks.reconnectBackend).not.toHaveBeenCalled()
  })

  test('开关翻转但当前不是 codex → 不重连', async () => {
    mocks.getCurrentId.mockReturnValue('claude')
    mocks.load.mockReturnValue(settingsWith(false))
    mocks.update.mockReturnValue(settingsWith(true))
    await updateSettings({ patch: {} })
    expect(mocks.reconnectBackend).not.toHaveBeenCalled()
  })
})
