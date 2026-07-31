// @vitest-environment node
import type { BridgeSettings, BridgeProvider } from '@shared/protocol/bridge-config'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// mock bridge-credentials（避免碰真实 userData）
vi.mock('@main/service/bridge-credentials', () => ({
  getStoredCredential: vi.fn((id: string) => (id === 'stored-ready' ? 'fake-key' : null)),
}))

const { BridgeManager } = await import('@main/protocol/manager')

function makeProvider(over: Partial<BridgeProvider> = {}): BridgeProvider {
  return {
    id: 'p1',
    name: 'test',
    presetId: 'custom',
    createdAt: 1,
    protocol: 'anthropic.messages',
    baseUrl: 'https://up.example.com',
    modelsUrl: '',
    model: 'm1',
    credentialSource: 'stored',
    credentialEnvVar: '',
    capabilities: {
      supportsImages: true,
      dropSamplingWhenThinking: true,
      defaultMaxOutputTokens: 8192,
      toolNameMaxLength: 64,
      preserveThinkingSignature: false,
    },
    modelListMode: 'manual',
    manualModels: ['m1', 'm2'],
    ...over,
  }
}

function makeSettings(
  providers: BridgeProvider[],
  currentProviderId: string,
  enabled = true,
): BridgeSettings {
  // providers 以 provider.id 为主键（与 manager.ts 的 providers[currentProviderId] 查找一致）
  const record: Record<string, BridgeProvider> = {}
  for (const p of providers) record[p.id] = p
  return { enabled, currentProviderId, providers: record }
}

describe('BridgeManager 多 provider', () => {
  let mgr: InstanceType<typeof BridgeManager>

  beforeEach(() => {
    mgr = new BridgeManager()
  })

  test('currentProvider 返回 currentProviderId 指向的 provider', async () => {
    const p1 = makeProvider({ id: 'p1' })
    const p2 = makeProvider({ id: 'p2', name: 'other' })
    await mgr.applySettings(makeSettings([p1, p2], 'p2'))
    // 通过 status().currentProviderId 间接验证
    expect(mgr.status().currentProviderId).toBe('p2')
  })

  test('currentProviderId 指向不存在的 provider 时 status.currentProviderId 为 null', async () => {
    await mgr.applySettings(makeSettings([makeProvider()], 'nope'))
    expect(mgr.status().currentProviderId).toBeNull()
  })

  test('currentProviderId 为空时 upstreamBaseUrl 为 null', async () => {
    await mgr.applySettings(makeSettings([makeProvider()], ''))
    expect(mgr.status().upstreamBaseUrl).toBeNull()
  })

  test('manual 模式 listUpstreamModels 返回手填列表，不联网', async () => {
    const p1 = makeProvider({ id: 'p1', manualModels: ['GLM-5.2', 'glm-4.6v'] })
    await mgr.applySettings(makeSettings([p1], 'p1'))
    const models = await mgr.listUpstreamModels()
    expect(models.map((m) => m.id)).toEqual(['GLM-5.2', 'glm-4.6v'])
  })

  test('manual 模式空凭证时 listUpstreamModels 仍返回手填列表', async () => {
    // manual 不依赖凭证（凭证只影响实际转发请求）
    const p1 = makeProvider({ id: 'no-cred', manualModels: ['x'] })
    await mgr.applySettings(makeSettings([p1], 'no-cred'))
    const models = await mgr.listUpstreamModels()
    expect(models.map((m) => m.id)).toEqual(['x'])
  })

  test('resolveCredential 按 provider.id 查凭证（stored）', async () => {
    const p1 = makeProvider({ id: 'stored-ready' }) // mock 返回 fake-key
    await mgr.applySettings(makeSettings([p1], 'stored-ready'))
    expect(mgr.status().credentialReady).toBe(true)
  })

  test('stored 凭证缺失时 credentialReady 为 false', async () => {
    const p1 = makeProvider({ id: 'no-key' })
    await mgr.applySettings(makeSettings([p1], 'no-key'))
    expect(mgr.status().credentialReady).toBe(false)
  })

  test('env 凭证：读环境变量', async () => {
    process.env.TEST_BRIDGE_KEY = 'env-value'
    const p1 = makeProvider({
      id: 'env-p',
      credentialSource: 'env',
      credentialEnvVar: 'TEST_BRIDGE_KEY',
    })
    await mgr.applySettings(makeSettings([p1], 'env-p'))
    expect(mgr.status().credentialReady).toBe(true)
    delete process.env.TEST_BRIDGE_KEY
  })

  test('切 provider 后手填列表内容变化即时生效（不进缓存）', async () => {
    const p1 = makeProvider({ id: 'p1', manualModels: ['a'] })
    await mgr.applySettings(makeSettings([p1], 'p1'))
    expect((await mgr.listUpstreamModels()).map((m) => m.id)).toEqual(['a'])
    // 改手填列表再 apply
    const p1b = { ...p1, manualModels: ['a', 'b', 'c'] }
    await mgr.applySettings(makeSettings([p1b], 'p1'))
    expect((await mgr.listUpstreamModels()).map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })
})
