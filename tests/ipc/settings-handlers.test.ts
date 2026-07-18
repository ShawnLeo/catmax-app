import { rmSync, existsSync } from 'node:fs'

import { describe, expect, test, afterEach, vi } from 'vitest'

const tempDirs: string[] = []

vi.mock('@main/context', async () => {
  const { SettingsStore } = await import('@main/service/settings-store')
  const { mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const tempDir = mkdtempSync(join(tmpdir(), 'catmax-settings-ipc-'))
  tempDirs.push(tempDir)
  return {
    ctx: {
      settingsStore: new SettingsStore(join(tempDir, 'settings.json')),
    },
  }
})

const { getSettings, updateSettings, resetSettings } =
  await import('@main/ipc/domains/settings/handlers')

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

describe('settings handlers', () => {
  test('getSettings 返回默认值', async () => {
    const s = await getSettings()
    expect(s.defaultBackend).toBe('codex')
    expect(s.theme.mode).toBe('system')
  })

  test('updateSettings 更新部分字段', async () => {
    const updated = await updateSettings({ patch: { defaultBackend: 'claude' } })
    expect(updated.defaultBackend).toBe('claude')
    const again = await getSettings()
    expect(again.defaultBackend).toBe('claude')
  })

  test('updateSettings 浅 merge theme 嵌套对象', async () => {
    const initial = await getSettings()
    const updated = await updateSettings({
      patch: { theme: { ...initial.theme, mode: 'dark' } },
    })
    expect(updated.theme.mode).toBe('dark')
    expect(updated.theme.fontSize).toBe(initial.theme.fontSize)
  })

  test('resetSettings 恢复默认', async () => {
    await updateSettings({ patch: { defaultBackend: 'claude' } })
    const reset = await resetSettings()
    expect(reset.defaultBackend).toBe('codex')
  })
})
