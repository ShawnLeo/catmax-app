import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SettingsStore } from '@main/service/settings-store'
import { describe, expect, test, beforeEach, afterEach } from 'vitest'

let tempDir: string
let store: SettingsStore

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'catmax-settings-test-'))
  store = new SettingsStore(join(tempDir, 'settings.json'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('SettingsStore', () => {
  test('load 文件不存在时返回默认值', () => {
    const settings = store.load()
    expect(settings.defaultBackend).toBe('codex')
    expect(settings.defaultEditor).toBe('vscode')
    expect(settings.theme.mode).toBe('system')
    expect(settings.sendOnEnter).toBe(true)
  })

  test('load 损坏 JSON 时回退到默认值', () => {
    writeFileSync(join(tempDir, 'settings.json'), '{ not valid json')
    const settings = store.load()
    expect(settings.defaultBackend).toBe('codex')
  })

  test('load 不符合 schema 时回退到默认值', () => {
    writeFileSync(
      join(tempDir, 'settings.json'),
      JSON.stringify({ defaultBackend: '../invalid-backend' }),
    )
    const settings = store.load()
    expect(settings.defaultBackend).toBe('codex') // 回退
  })

  test('update 部分更新（浅 merge 嵌套对象）', () => {
    const initial = store.load()
    const updated = store.update({ theme: { ...initial.theme, mode: 'dark' } })
    expect(updated.theme.mode).toBe('dark')
    expect(updated.theme.fontSize).toBe(initial.theme.fontSize) // 其他字段保留
  })

  test('update defaultRuntimeConfig 按 backend 双层 deep merge', () => {
    // 先设 codex 的 model + effort
    store.update({
      defaultRuntimeConfig: {
        codex: { model: 'gpt-5.6-sol', effort: 'high', permissionMode: null },
        claude: { model: null, effort: null, permissionMode: null },
      },
    })
    // 再只改 claude 的 model——codex 配置应保留（双层 deep merge）
    const current = store.load()
    const updated = store.update({
      defaultRuntimeConfig: {
        ...current.defaultRuntimeConfig,
        claude: { ...current.defaultRuntimeConfig.claude, model: 'sonnet' },
      },
    })
    // codex 配置保留
    expect(updated.defaultRuntimeConfig.codex.model).toBe('gpt-5.6-sol')
    expect(updated.defaultRuntimeConfig.codex.effort).toBe('high')
    // claude 配置更新
    expect(updated.defaultRuntimeConfig.claude.model).toBe('sonnet')
    expect(updated.defaultRuntimeConfig.claude.effort).toBeNull()
  })

  test('update 写盘后重新 load 仍能拿到值', () => {
    store.update({ defaultBackend: 'claude' })
    const newStore = new SettingsStore(join(tempDir, 'settings.json'))
    expect(newStore.load().defaultBackend).toBe('claude')
  })

  test('窗口状态写盘后可完整恢复', () => {
    const windowState = {
      x: -1200,
      y: 80,
      width: 900,
      height: 700,
      maximized: false,
      fullScreen: false,
      alwaysOnTop: true,
    }
    store.update({ windowState })

    const newStore = new SettingsStore(join(tempDir, 'settings.json'))
    expect(newStore.load().windowState).toEqual(windowState)
  })

  test('reset 恢复默认', () => {
    store.update({ defaultBackend: 'claude', sendOnEnter: false })
    const reset = store.reset()
    expect(reset.defaultBackend).toBe('codex')
    expect(reset.sendOnEnter).toBe(true)
  })
})
