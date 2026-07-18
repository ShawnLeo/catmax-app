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
      JSON.stringify({ defaultBackend: 'invalid-backend' }),
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

  test('update 写盘后重新 load 仍能拿到值', () => {
    store.update({ defaultBackend: 'claude' })
    const newStore = new SettingsStore(join(tempDir, 'settings.json'))
    expect(newStore.load().defaultBackend).toBe('claude')
  })

  test('reset 恢复默认', () => {
    store.update({ defaultBackend: 'claude', sendOnEnter: false })
    const reset = store.reset()
    expect(reset.defaultBackend).toBe('codex')
    expect(reset.sendOnEnter).toBe(true)
  })
})
