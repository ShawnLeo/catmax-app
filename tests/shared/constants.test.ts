import { BACKEND_IDS, EDITOR_IDS, IPC, PUSH, STORAGE_KEYS } from '@shared/constants'
import { describe, expect, test } from 'vitest'

describe('constants', () => {
  test('BACKEND_IDS 包含 codex 和 claude', () => {
    expect(BACKEND_IDS).toEqual(['codex', 'claude'])
  })

  test('EDITOR_IDS 包含 5 个编辑器', () => {
    expect(EDITOR_IDS).toEqual(['vscode', 'cursor', 'intellij', 'webstorm', 'sublime'])
    expect(EDITOR_IDS).toHaveLength(5)
  })

  test('IPC 方法名用点分', () => {
    expect(IPC.WORKSPACE_LIST).toBe('workspace.list')
    expect(IPC.SETTINGS_GET).toBe('settings.get')
    expect(IPC.SYSTEM_OPEN_DIALOG).toBe('system.openDialog')
  })

  test('PUSH 推送事件用冒号分隔', () => {
    expect(PUSH.BACKEND_TURN_EVENT).toBe('backend:turnEvent')
    expect(PUSH.PTY_DATA).toBe('pty:data')
  })

  test('STORAGE_KEYS 唯一', () => {
    const values = Object.values(STORAGE_KEYS)
    expect(new Set(values).size).toBe(values.length)
  })
})
