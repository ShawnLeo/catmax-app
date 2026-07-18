import { appSettingsSchema } from '@shared/settings-schema'
import { describe, expect, test } from 'vitest'

describe('settings-schema', () => {
  test('空对象解析为完整默认值', () => {
    const result = appSettingsSchema.parse({})
    expect(result.defaultBackend).toBe('codex')
    expect(result.defaultEditor).toBe('vscode')
    expect(result.theme.mode).toBe('system')
    expect(result.theme.fontSize).toBe(14)
    expect(result.theme.chatFontSize).toBe(15)
    expect(result.theme.codeFontSize).toBe(13)
    expect(result.sendOnEnter).toBe(true)
    expect(result.language).toBe('zh-CN')
    expect(result.httpProxy.enabled).toBe(false)
    expect(result.backendPaths.codex).toBeNull()
    expect(result.backendPaths.claude).toBeNull()
  })

  test('部分输入与默认值合并', () => {
    const result = appSettingsSchema.parse({ defaultBackend: 'claude' })
    expect(result.defaultBackend).toBe('claude')
    expect(result.defaultEditor).toBe('vscode') // default
  })

  test('无效 backend 抛错', () => {
    expect(() => appSettingsSchema.parse({ defaultBackend: 'invalid' })).toThrow()
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
