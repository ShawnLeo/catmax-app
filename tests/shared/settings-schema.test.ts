import { appSettingsSchema } from '@shared/settings-schema'
import { describe, expect, test } from 'vitest'

describe('settings-schema', () => {
  test('空对象解析为完整默认值', () => {
    const result = appSettingsSchema.parse({})
    expect(result.defaultBackend).toBe('codex')
    expect(result.defaultEditor).toBe('vscode')
    expect(result.theme.mode).toBe('system')
    // 三条字号基准（界面 / 对话 / 等宽），与 themes.css 里同名 CSS 变量的兜底值一一对应
    expect(result.theme.fontSize).toBe(14)
    expect(result.theme.chatFontSize).toBe(13)
    expect(result.theme.codeFontSize).toBe(13)
    expect(result.sendOnEnter).toBe(true)
    expect(result.language).toBe('zh-CN')
    expect(result.httpProxy.enabled).toBe(false)
    expect(result.backendPaths.codex).toBeNull()
    expect(result.backendPaths.claude).toBeNull()
    // 默认运行时配置——按 backend 分别配，未配置时各字段为 null
    expect(result.defaultRuntimeConfig.codex.model).toBeNull()
    expect(result.defaultRuntimeConfig.codex.effort).toBeNull()
    expect(result.defaultRuntimeConfig.codex.permissionMode).toBeNull()
    expect(result.defaultRuntimeConfig.claude.model).toBeNull()
    expect(result.defaultRuntimeConfig.claude.effort).toBeNull()
    expect(result.defaultRuntimeConfig.claude.permissionMode).toBeNull()
  })

  test('默认运行时配置可按 backend 分别解析', () => {
    const result = appSettingsSchema.parse({
      defaultRuntimeConfig: {
        codex: { model: 'gpt-5.6-sol', effort: 'high', permissionMode: 'acceptEdits' },
        claude: { model: 'sonnet', effort: 'xhigh', permissionMode: 'bypassPermissions' },
      },
    })
    expect(result.defaultRuntimeConfig.codex.model).toBe('gpt-5.6-sol')
    expect(result.defaultRuntimeConfig.codex.effort).toBe('high')
    expect(result.defaultRuntimeConfig.codex.permissionMode).toBe('acceptEdits')
    expect(result.defaultRuntimeConfig.claude.model).toBe('sonnet')
    expect(result.defaultRuntimeConfig.claude.effort).toBe('xhigh')
    expect(result.defaultRuntimeConfig.claude.permissionMode).toBe('bypassPermissions')
  })

  test('defaultRuntimeConfig 部分字段缺失时用 null 兜底', () => {
    const result = appSettingsSchema.parse({
      defaultRuntimeConfig: {
        codex: { model: 'gpt-5.6-sol' },
        claude: {},
      },
    })
    expect(result.defaultRuntimeConfig.codex.model).toBe('gpt-5.6-sol')
    expect(result.defaultRuntimeConfig.codex.effort).toBeNull()
    expect(result.defaultRuntimeConfig.codex.permissionMode).toBeNull()
    expect(result.defaultRuntimeConfig.claude.model).toBeNull()
  })

  test('无效 effort 抛错', () => {
    expect(() =>
      appSettingsSchema.parse({ defaultRuntimeConfig: { codex: { effort: 'invalid' } } }),
    ).toThrow()
  })

  test('无效 permissionMode 抛错', () => {
    expect(() =>
      appSettingsSchema.parse({
        defaultRuntimeConfig: { codex: { permissionMode: 'invalid' } },
      }),
    ).toThrow()
  })

  test('部分输入与默认值合并', () => {
    const result = appSettingsSchema.parse({ defaultBackend: 'claude' })
    expect(result.defaultBackend).toBe('claude')
    expect(result.defaultEditor).toBe('vscode') // default
  })

  test('非法 backend id 抛错，合法插件 id 可用', () => {
    expect(() => appSettingsSchema.parse({ defaultBackend: '../invalid' })).toThrow()
    expect(appSettingsSchema.parse({ defaultBackend: 'acme.demo' }).defaultBackend).toBe(
      'acme.demo',
    )
  })

  test('保留插件 backend 的路径与默认运行配置', () => {
    const result = appSettingsSchema.parse({
      defaultBackend: 'acme.demo',
      backendPaths: { codex: null, claude: null, 'acme.demo': '/bin/demo' },
      defaultRuntimeConfig: {
        codex: {},
        claude: {},
        'acme.demo': { model: 'demo-1', effort: 'low' },
      },
    })
    expect(result.backendPaths['acme.demo']).toBe('/bin/demo')
    expect(result.defaultRuntimeConfig['acme.demo']?.model).toBe('demo-1')
    expect(result.defaultRuntimeConfig['acme.demo']?.permissionMode).toBeNull()
  })

  test('无效 theme mode 抛错', () => {
    expect(() => appSettingsSchema.parse({ theme: { mode: 'invalid' } })).toThrow()
  })

  test('fontSize 超出范围抛错', () => {
    expect(() => appSettingsSchema.parse({ theme: { fontSize: 5 } })).toThrow()
    expect(() => appSettingsSchema.parse({ theme: { fontSize: 100 } })).toThrow()
  })

  test('theme fontFamily 默认 null', () => {
    const result = appSettingsSchema.parse({})
    expect(result.theme.fontFamily.sans).toBeNull()
    expect(result.theme.fontFamily.chat).toBeNull()
    expect(result.theme.fontFamily.mono).toBeNull()
  })

  test('httpProxy 部分输入补默认', () => {
    const result = appSettingsSchema.parse({ httpProxy: { enabled: true } })
    expect(result.httpProxy.enabled).toBe(true)
    expect(result.httpProxy.url).toBeNull() // default
  })
})
