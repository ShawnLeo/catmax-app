// @vitest-environment node
//
// 验证旧 codex-bridge 凭证迁移到当前 provider UUID key 的一次性逻辑。
// 多配置改造前凭证存在固定 'codex-bridge' key 下；改造后按 provider.id 隔离，
// 旧用户升级后那条 key 变孤儿——applySettings 要把它搬到当前 provider 名下。
import type { BridgeSettings, BridgeProvider } from '@shared/protocol/bridge-config'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// 基于状态的 mock：记录 set/clear 的副作用，让迁移逻辑能被验证
const credStore = vi.hoisted(() => {
  const store: Record<string, string> = {}
  return {
    store,
    getStoredCredential: vi.fn((id: string) => store[id] ?? null),
    setStoredCredential: vi.fn((id: string, secret: string) => {
      if (secret) store[id] = secret
      else delete store[id]
    }),
    clearStoredCredential: vi.fn((id: string) => {
      delete store[id]
    }),
    reset: () => {
      for (const k of Object.keys(store)) delete store[k]
    },
  }
})

vi.mock('@main/service/bridge-credentials', () => ({
  getStoredCredential: credStore.getStoredCredential,
  setStoredCredential: credStore.setStoredCredential,
  clearStoredCredential: credStore.clearStoredCredential,
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
    authScheme: 'x-api-key',
    capabilities: {
      supportsImages: true,
      dropSamplingWhenThinking: true,
      defaultMaxOutputTokens: 8192,
      toolNameMaxLength: 64,
      preserveThinkingSignature: false,
    },
    modelListMode: 'manual',
    manualModels: ['m1'],
    ...over,
  }
}

function makeSettings(
  providers: Record<string, BridgeProvider>,
  currentProviderId: string,
  enabled = true,
): BridgeSettings {
  return { enabled, currentProviderId, providers }
}

describe('旧 codex-bridge 凭证迁移', () => {
  let mgr: InstanceType<typeof BridgeManager>

  beforeEach(() => {
    credStore.reset()
    credStore.getStoredCredential.mockClear()
    credStore.setStoredCredential.mockClear()
    credStore.clearStoredCredential.mockClear()
    mgr = new BridgeManager()
  })

  test('旧 key 存在、当前 provider 无 key → 迁移并清旧 key', async () => {
    // 模拟旧用户：凭证在固定 'codex-bridge' key 下
    credStore.store['codex-bridge'] = 'legacy-key'
    const provider = makeProvider({ id: 'uuid-abc' })
    await mgr.applySettings(makeSettings({ 'uuid-abc': provider }, 'uuid-abc'))

    // 旧 key 被搬到 provider UUID 下
    expect(credStore.store['uuid-abc']).toBe('legacy-key')
    // 旧 key 已清
    expect(credStore.store['codex-bridge']).toBeUndefined()
  })

  test('迁移后 resolveCredential 能查到（listUpstreamModels 不再回退 codex）', async () => {
    credStore.store['codex-bridge'] = 'legacy-key'
    const provider = makeProvider({ id: 'uuid-abc', modelListMode: 'auto', manualModels: [] })
    await mgr.applySettings(makeSettings({ 'uuid-abc': provider }, 'uuid-abc'))

    // 迁移生效后凭证就绪——这是修复的核心目标
    expect(mgr.status().credentialReady).toBe(true)
  })

  test('当前 provider 已有自己的 key → 不迁移（不覆盖用户已保存的）', async () => {
    credStore.store['codex-bridge'] = 'legacy-key'
    credStore.store['uuid-abc'] = 'new-key' // 用户已在新 UI 保存过
    const provider = makeProvider({ id: 'uuid-abc' })
    await mgr.applySettings(makeSettings({ 'uuid-abc': provider }, 'uuid-abc'))

    // 用户的新 key 保留，旧 key 也保留（无害，因为没有 provider 引用它）
    expect(credStore.store['uuid-abc']).toBe('new-key')
    expect(credStore.store['codex-bridge']).toBe('legacy-key')
    expect(credStore.setStoredCredential).not.toHaveBeenCalled()
  })

  test('旧 key 不存在 → 不迁移', async () => {
    // 全新安装，从没有过旧 key
    const provider = makeProvider({ id: 'uuid-abc' })
    await mgr.applySettings(makeSettings({ 'uuid-abc': provider }, 'uuid-abc'))

    expect(credStore.setStoredCredential).not.toHaveBeenCalled()
    expect(mgr.status().credentialReady).toBe(false)
  })

  test('env 来源的 provider → 不迁移（env 不落盘）', async () => {
    credStore.store['codex-bridge'] = 'legacy-key'
    const provider = makeProvider({
      id: 'env-p',
      credentialSource: 'env',
      credentialEnvVar: 'SOME_VAR',
    })
    await mgr.applySettings(makeSettings({ 'env-p': provider }, 'env-p'))

    // env 来源不该碰凭证文件
    expect(credStore.setStoredCredential).not.toHaveBeenCalled()
    expect(credStore.store['codex-bridge']).toBe('legacy-key')
  })

  test('迁移幂等：applySettings 第二次不再迁移（旧 key 已清）', async () => {
    credStore.store['codex-bridge'] = 'legacy-key'
    const provider = makeProvider({ id: 'uuid-abc' })
    await mgr.applySettings(makeSettings({ 'uuid-abc': provider }, 'uuid-abc'))
    expect(credStore.setStoredCredential).toHaveBeenCalledTimes(1)

    // 再次 applySettings——旧 key 已不存在，不应再触发迁移
    credStore.setStoredCredential.mockClear()
    await mgr.applySettings(makeSettings({ 'uuid-abc': provider }, 'uuid-abc'))
    expect(credStore.setStoredCredential).not.toHaveBeenCalled()
  })

  test('切到另一个 provider 后，旧 key 已清，不会再迁给它', async () => {
    credStore.store['codex-bridge'] = 'legacy-key'
    const p1 = makeProvider({ id: 'p1' })
    const p2 = makeProvider({ id: 'p2' })
    await mgr.applySettings(makeSettings({ p1, p2 }, 'p1'))
    // 第一次迁移已清掉 codex-bridge
    expect(credStore.store['p1']).toBe('legacy-key')
    expect(credStore.store['codex-bridge']).toBeUndefined()

    // 切到 p2——p2 没有 key，但旧 key 也没了，所以不会迁
    credStore.setStoredCredential.mockClear()
    await mgr.applySettings(makeSettings({ p1, p2 }, 'p2'))
    expect(credStore.setStoredCredential).not.toHaveBeenCalled()
    expect(mgr.status().credentialReady).toBe(false)
  })
})
