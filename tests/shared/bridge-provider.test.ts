// @vitest-environment node
import {
  BRIDGE_UPSTREAM_PRESETS,
  bridgeUpstreamPreset,
  createProviderFromPreset,
} from '@shared/protocol/bridge-config'
import { describe, expect, test } from 'vitest'

describe('createProviderFromPreset', () => {
  test('各预设生成的 provider 字段正确填充', () => {
    for (const preset of BRIDGE_UPSTREAM_PRESETS) {
      const provider = createProviderFromPreset(preset.id)
      expect(provider.id).toBeTruthy()
      expect(provider.presetId).toBe(preset.id)
      expect(provider.name).toBe(preset.label)
      expect(typeof provider.createdAt).toBe('number')
      // 模型列表字段必填
      expect(['auto', 'manual']).toContain(provider.modelListMode)
      expect(Array.isArray(provider.manualModels)).toBe(true)
      // 凭证来源默认 stored
      expect(provider.credentialSource).toBe('stored')
      // 预设的 baseUrl/protocol 透传
      expect(provider.baseUrl).toBe(preset.config.baseUrl)
      expect(provider.protocol).toBe(preset.config.protocol)
    }
  })

  test('智谱预设有 modelListMode=manual 且预填模型', () => {
    const provider = createProviderFromPreset('zhipu')
    expect(provider.modelListMode).toBe('manual')
    expect(provider.manualModels).toEqual(['glm-5.2', 'glm-5-turbo', 'glm-4.7'])
    expect(provider.baseUrl).toBe('https://open.bigmodel.cn/api/anthropic')
    expect(provider.model).toBe('glm-5.2')
    expect(provider.credentialEnvVar).toBe('ZHIPUAI_API_KEY')
  })

  test('deepseek/anthropic/custom 预设是 auto 模式', () => {
    for (const id of ['deepseek', 'anthropic', 'custom']) {
      expect(createProviderFromPreset(id).modelListMode).toBe('auto')
    }
  })

  test('credentialSource 参数透传', () => {
    expect(createProviderFromPreset('deepseek', 'env').credentialSource).toBe('env')
  })

  test('未知 presetId 回退到 custom', () => {
    const provider = createProviderFromPreset('不存在的预设')
    expect(provider.presetId).toBe('custom')
  })

  test('每次调用生成不同的 id', () => {
    const a = createProviderFromPreset('deepseek')
    const b = createProviderFromPreset('deepseek')
    expect(a.id).not.toBe(b.id)
  })

  test('bridgeUpstreamPreset 能查到智谱', () => {
    expect(bridgeUpstreamPreset('zhipu')?.id).toBe('zhipu')
  })
})
