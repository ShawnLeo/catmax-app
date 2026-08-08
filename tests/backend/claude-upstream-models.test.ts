// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

interface FakeSdkModelInfo {
  value: string
  resolvedModel?: string
  displayName: string
  description?: string
}
interface FakeQueryHandle {
  [Symbol.asyncIterator](): AsyncGenerator<{ type: string; subtype: string }, void, unknown>
  initializationResult: () => Promise<{ models: FakeSdkModelInfo[]; commands?: unknown[] }>
}

const sdkMocks = vi.hoisted(() => ({
  deleteSession: vi.fn(async () => {}),
  query: vi.fn((_params: unknown): FakeQueryHandle => ({
    async *[Symbol.asyncIterator]() {},
    initializationResult: vi.fn(async () => ({ models: [] })),
  })),
}))

const overrideSettingsMocks = vi.hoisted(() => ({
  claudeOverrideSettingsPath: vi.fn((): string | null => null),
  readClaudeOverrideSettings: vi.fn((_path: string): Record<string, unknown> => ({})),
}))

const upstreamModelsMocks = vi.hoisted(() => ({
  fetchUpstreamModels: vi.fn(),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  deleteSession: sdkMocks.deleteSession,
  query: sdkMocks.query,
}))
vi.mock('electron', () => ({
  app: { isPackaged: false },
}))
vi.mock('@main/service/backend-config-files', () => overrideSettingsMocks)
vi.mock('@main/protocol/upstream-models', () => upstreamModelsMocks)

const { ClaudeAdapter } = await import('@main/backend/claude/adapter')

describe('ClaudeAdapter upstream 模型探测', () => {
  beforeEach(() => {
    sdkMocks.query.mockClear()
    overrideSettingsMocks.claudeOverrideSettingsPath.mockReset().mockReturnValue(null)
    overrideSettingsMocks.readClaudeOverrideSettings.mockReset().mockReturnValue({})
    upstreamModelsMocks.fetchUpstreamModels.mockReset()
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('没配自定义 ANTHROPIC_BASE_URL 时不探测，走 SDK 静态 fallback', async () => {
    const adapter = new ClaudeAdapter()

    const models = await adapter.listModels()

    expect(upstreamModelsMocks.fetchUpstreamModels).not.toHaveBeenCalled()
    expect(models.map((m) => m.id)).toEqual(['sonnet', 'opus', 'haiku'])
  })

  test('官方 ANTHROPIC_BASE_URL（api.anthropic.com）不触发探测', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.anthropic.com')
    const adapter = new ClaudeAdapter()

    await adapter.listModels()

    expect(upstreamModelsMocks.fetchUpstreamModels).not.toHaveBeenCalled()
  })

  test('自定义上游探测成功——下拉框 id 与实际发给 SDK 的 model 完全一致', async () => {
    overrideSettingsMocks.claudeOverrideSettingsPath.mockReturnValue('/fake/override.json')
    overrideSettingsMocks.readClaudeOverrideSettings.mockReturnValue({
      env: {
        ANTHROPIC_BASE_URL: 'https://relay.example.com',
        ANTHROPIC_AUTH_TOKEN: 'sk-fake',
      },
    })
    upstreamModelsMocks.fetchUpstreamModels.mockResolvedValue([
      { id: 'glm-5.2', displayName: 'GLM 5.2' },
    ])
    const adapter = new ClaudeAdapter()

    const models = await adapter.listModels()
    expect(models).toEqual([{ id: 'glm-5.2', displayName: 'GLM 5.2' }])
    expect(upstreamModelsMocks.fetchUpstreamModels).toHaveBeenCalledWith({
      modelsUrl: '',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-fake',
    })

    // 选中的 id 必须原样成为实际请求里的 model——不能只是展示用的别名。
    await adapter.warmup({ cwd: '/tmp/project', model: models[0]!.id })
    const call = sdkMocks.query.mock.calls[0]![0] as { options: { model?: string } }
    expect(call.options.model).toBe('glm-5.2')
  })

  test('探测失败且没配 ANTHROPIC_DEFAULT_*_MODEL 时，静默回退到 SDK 静态目录，不抛错', async () => {
    overrideSettingsMocks.claudeOverrideSettingsPath.mockReturnValue('/fake/override.json')
    overrideSettingsMocks.readClaudeOverrideSettings.mockReturnValue({
      env: { ANTHROPIC_BASE_URL: 'https://relay.example.com' },
    })
    upstreamModelsMocks.fetchUpstreamModels.mockRejectedValue(new Error('网络不通'))
    const adapter = new ClaudeAdapter()

    const models = await adapter.listModels()

    expect(models.map((m) => m.id)).toEqual(['sonnet', 'opus', 'haiku'])
  })

  test('探测失败（中转没有 /models 接口）时，退到 ANTHROPIC_DEFAULT_*_MODEL 配置，不发网络请求即可拿到真实模型', async () => {
    overrideSettingsMocks.claudeOverrideSettingsPath.mockReturnValue('/fake/override.json')
    overrideSettingsMocks.readClaudeOverrideSettings.mockReturnValue({
      env: {
        ANTHROPIC_BASE_URL: 'https://www.catmax.cn',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7',
      },
    })
    // 模拟用户实测的真实情况：/v1/models 401，/models 404（HTML）——都失败。
    upstreamModelsMocks.fetchUpstreamModels.mockRejectedValue(
      new Error('https://www.catmax.cn/v1/models → 401 认证失败'),
    )
    const adapter = new ClaudeAdapter()

    const models = await adapter.listModels()

    // Opus 和 Sonnet 都映射到同一个 glm-5.2，应该合并成一条，而不是两条重复 id；
    // displayName 直接是真实模型名，不套 Opus/Sonnet 这层别名前缀。
    expect(models).toEqual([
      { id: 'glm-5.2', displayName: 'glm-5.2' },
      { id: 'glm-4.7', displayName: 'glm-4.7' },
    ])

    // 选中派生出来的 id，必须原样成为下一次请求里的 model。
    await adapter.warmup({ cwd: '/tmp/project', model: models[0]!.id })
    const call = sdkMocks.query.mock.calls[0]![0] as { options: { model?: string } }
    expect(call.options.model).toBe('glm-5.2')
  })

  test('命中缓存时第二次调用不重新探测', async () => {
    overrideSettingsMocks.claudeOverrideSettingsPath.mockReturnValue('/fake/override.json')
    overrideSettingsMocks.readClaudeOverrideSettings.mockReturnValue({
      env: { ANTHROPIC_BASE_URL: 'https://relay.example.com' },
    })
    upstreamModelsMocks.fetchUpstreamModels.mockResolvedValue([
      { id: 'glm-5.2', displayName: 'GLM 5.2' },
    ])
    const adapter = new ClaudeAdapter()

    await adapter.listModels()
    await adapter.listModels()

    expect(upstreamModelsMocks.fetchUpstreamModels).toHaveBeenCalledTimes(1)
  })

  test('invalidateModelsCache 后重新探测（切档/改配置场景）', async () => {
    overrideSettingsMocks.claudeOverrideSettingsPath.mockReturnValue('/fake/override.json')
    overrideSettingsMocks.readClaudeOverrideSettings.mockReturnValue({
      env: { ANTHROPIC_BASE_URL: 'https://relay.example.com' },
    })
    upstreamModelsMocks.fetchUpstreamModels.mockResolvedValueOnce([
      { id: 'glm-5.2', displayName: 'GLM 5.2' },
    ])
    const adapter = new ClaudeAdapter()

    const first = await adapter.listModels()
    expect(first.map((m) => m.id)).toEqual(['glm-5.2'])

    upstreamModelsMocks.fetchUpstreamModels.mockResolvedValueOnce([
      { id: 'kimi-k3', displayName: 'Kimi K3' },
    ])
    adapter.invalidateModelsCache?.()
    const second = await adapter.listModels()

    expect(second.map((m) => m.id)).toEqual(['kimi-k3'])
    expect(upstreamModelsMocks.fetchUpstreamModels).toHaveBeenCalledTimes(2)
  })
})

describe('ClaudeAdapter resolvedModel 映射（探测和 alias env 都没有时，modelsCache 这一层的兜底）', () => {
  beforeEach(() => {
    sdkMocks.query.mockClear()
    overrideSettingsMocks.claudeOverrideSettingsPath.mockReset().mockReturnValue(null)
    overrideSettingsMocks.readClaudeOverrideSettings.mockReset().mockReturnValue({})
    upstreamModelsMocks.fetchUpstreamModels.mockReset()
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('resolvedModel 跟 value 不同时，id/displayName 用真实模型，且原样发给 SDK', async () => {
    // 没配自定义上游——没有 /models 可探测，必须靠 modelsCache 的 resolvedModel 兜底。
    sdkMocks.query.mockImplementationOnce(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init' }
      },
      initializationResult: vi.fn(async () => ({
        models: [
          {
            value: 'sonnet',
            resolvedModel: 'glm-5.2',
            displayName: 'Sonnet',
            description: 'Sonnet · Efficient for routine tasks',
          },
          {
            value: 'opus',
            resolvedModel: 'opus',
            displayName: 'Opus',
            description: 'Opus 5',
          },
        ],
        commands: [],
      })),
    }))
    const adapter = new ClaudeAdapter()

    // 走一次 warmup 让 SDK 的 init 消息把 modelsCache 灌进去（跟正式 turn 是同一条路径）。
    await adapter.warmup({ cwd: '/tmp/project', model: 'sonnet' })

    const models = await adapter.listModels()
    expect(models).toEqual([
      {
        // resolvedModel 跟 value 不同——displayName 直接是 'glm-5.2'，不套 'Sonnet (glm-5.2)'。
        id: 'glm-5.2',
        displayName: 'glm-5.2',
        description: 'Sonnet · Efficient for routine tasks',
      },
      // resolvedModel 跟 value 相同（官方场景）——保持原样，还是 'Opus'。
      { id: 'opus', displayName: 'Opus', description: 'Opus 5' },
    ])

    // 选中派生出来的 id，必须原样成为下一次请求里的 model——不能是 'sonnet' 别名。
    await adapter.warmup({ cwd: '/tmp/project', model: models[0]!.id })
    const lastCall = sdkMocks.query.mock.calls.at(-1)![0] as { options: { model?: string } }
    expect(lastCall.options.model).toBe('glm-5.2')
  })
})
