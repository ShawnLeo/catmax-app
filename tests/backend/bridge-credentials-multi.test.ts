// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

// bridge-credentials 在 app.getPath 不可用（测试环境）时会自动退回 TMPDIR，无需手动指定
const { setStoredCredential, getStoredCredential, clearStoredCredential, hasStoredCredential } =
  await import('@main/service/bridge-credentials')

describe('bridge-credentials 多 provider 独立', () => {
  beforeEach(() => {
    // 防止残留状态污染：每个用例前先清掉本测试涉及的 id
    for (const id of ['p1', 'p2', 'p3']) clearStoredCredential(id)
  })

  afterEach(() => {
    // 清掉本测试写入的 key
    for (const id of ['p1', 'p2', 'p3']) clearStoredCredential(id)
  })

  test('不同 id 独立存取', () => {
    setStoredCredential('p1', 'key-a')
    setStoredCredential('p2', 'key-b')
    expect(getStoredCredential('p1')).toBe('key-a')
    expect(getStoredCredential('p2')).toBe('key-b')
  })

  test('删一个不影响其他', () => {
    setStoredCredential('p1', 'key-a')
    setStoredCredential('p2', 'key-b')
    clearStoredCredential('p1')
    expect(getStoredCredential('p1')).toBeNull()
    expect(getStoredCredential('p2')).toBe('key-b')
  })

  test('传空串即清除', () => {
    setStoredCredential('p3', 'key-c')
    setStoredCredential('p3', '')
    expect(getStoredCredential('p3')).toBeNull()
    expect(hasStoredCredential('p3')).toBe(false)
  })

  test('不存在的 id 返回 null', () => {
    expect(getStoredCredential('never-set')).toBeNull()
    expect(hasStoredCredential('never-set')).toBe(false)
  })
})
