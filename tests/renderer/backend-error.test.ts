/**
 * Bug H 测试：renderer 端 explainBackendError 把 main 的错误码转成可读信息。
 */
import { describe, expect, test } from 'vitest'

import { explainBackendError } from '../../src/renderer/src/lib/backend-error'

describe('explainBackendError', () => {
  test('killed-by-os 给出 macOS Gatekeeper 的解释 + 修复步骤', () => {
    const info = explainBackendError('killed-by-os')
    expect(info.title).toContain('SIGKILL')
    expect(info.detail.toLowerCase()).toMatch(/gatekeeper|macos|签名|sigkill/)
    expect(info.fix).toBeDefined()
    expect(info.fix!.length).toBeGreaterThan(0)
    // 修复步骤里至少有一条提到「系统设置」或「隐私」
    expect(info.fix!.some((s) => s.includes('系统设置') || s.includes('隐私'))).toBe(true)
  })

  test('not-installed 给出安装指引', () => {
    const info = explainBackendError('not-installed')
    expect(info.title).toContain('未安装')
    expect(info.fix).toBeDefined()
    // 至少提到 codex 或 claude 的安装命令
    expect(info.fix!.some((s) => s.includes('codex') || s.includes('claude'))).toBe(true)
  })

  test('null/undefined 时兜底「不可用」', () => {
    expect(explainBackendError(null).title).toContain('不可用')
    expect(explainBackendError(undefined).title).toContain('不可用')
  })

  test('未知错误码兜底（不崩）', () => {
    const info = explainBackendError('some-new-error-2026')
    expect(info.title).toBe('some-new-error-2026')
    expect(info.detail).toContain('some-new-error-2026')
  })

  test('timeout 给出诊断方向', () => {
    const info = explainBackendError('timeout')
    expect(info.title).toContain('超时')
    expect(info.fix).toBeDefined()
  })

  test('兼容旧的 spawn-failed 错误码', () => {
    const info = explainBackendError('spawn-failed')
    expect(info.title).toBeTruthy()
    expect(info.detail).toBeTruthy()
  })
})
