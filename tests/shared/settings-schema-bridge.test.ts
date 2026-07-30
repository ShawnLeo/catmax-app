// @vitest-environment node
import { describe, expect, test } from 'vitest'

import { appSettingsSchema } from '@shared/settings-schema'

describe('protocolBridge schema', () => {
  test('空对象走 default：enabled=false, currentProviderId="", providers={}', () => {
    const parsed = appSettingsSchema.parse({}).protocolBridge
    expect(parsed.enabled).toBe(false)
    expect(parsed.currentProviderId).toBe('')
    expect(parsed.providers).toEqual({})
  })

  test('provider 记录正确解析，含 modelListMode/manualModels', () => {
    const parsed = appSettingsSchema.parse({
      protocolBridge: {
        enabled: true,
        currentProviderId: 'p1',
        providers: {
          p1: {
            id: 'p1',
            name: '我的 DeepSeek',
            presetId: 'deepseek',
            createdAt: 1000,
            protocol: 'anthropic.messages',
            baseUrl: 'https://api.deepseek.com/anthropic',
            modelsUrl: 'https://api.deepseek.com/models',
            model: 'deepseek-v4-pro',
            credentialSource: 'stored',
            credentialEnvVar: 'DEEPSEEK_API_KEY',
            capabilities: { supportsImages: false },
            modelListMode: 'manual',
            manualModels: ['a', 'b'],
          },
        },
      },
    }).protocolBridge
    // noUncheckedIndexedAccess：Record 索引是 T | undefined；测试自己塞了 p1，用 ! 断言安全
    const p1 = parsed.providers.p1!
    expect(p1.modelListMode).toBe('manual')
    expect(p1.manualModels).toEqual(['a', 'b'])
    expect(p1.capabilities.supportsImages).toBe(false)
  })

  test('旧 upstream 字段被静默剥掉不报错（向后兼容）', () => {
    // 旧 settings.json 残留 upstream/presetId，新 schema 非 strict 会剥除
    const parsed = appSettingsSchema.parse({
      protocolBridge: {
        enabled: true,
        presetId: 'deepseek',
        upstream: { baseUrl: 'https://old.example.com', protocol: 'anthropic.messages' },
      },
    }).protocolBridge
    // 新字段走 default
    expect(parsed.currentProviderId).toBe('')
    expect(parsed.providers).toEqual({})
    // 旧字段不存在于解析结果
    expect((parsed as unknown as Record<string, unknown>).upstream).toBeUndefined()
    expect((parsed as unknown as Record<string, unknown>).presetId).toBeUndefined()
  })

  test('provider 缺 modelListMode 时走 default auto', () => {
    const parsed = appSettingsSchema.parse({
      protocolBridge: {
        providers: { p1: { id: 'p1', baseUrl: 'x', protocol: 'anthropic.messages' } },
      },
    }).protocolBridge
    const p1 = parsed.providers.p1!
    expect(p1.modelListMode).toBe('auto')
    expect(p1.manualModels).toEqual([])
  })
})
