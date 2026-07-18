import { resolveCodexPath } from '@main/service/codex-resolver'
import { describe, expect, test } from 'vitest'

describe('resolveCodexPath', () => {
  test('自定义路径存在时返回', async () => {
    // /bin/cat 是肯定存在的（不是真的 codex，但测路径解析逻辑）
    const result = await resolveCodexPath('/bin/cat')
    expect(result).toBe('/bin/cat')
  })

  test('自定义路径不存在时 fallback', async () => {
    // 路径不存在，会走 which codex 流程；如果环境没装 codex，返回 null 或 PATH 里的
    const result = await resolveCodexPath('/nonexistent/path/xyz')
    // 不严格断言（取决于环境），只验证不抛错
    expect(typeof result === 'string' || result === null).toBe(true)
  })

  test('不传自定义路径，从 PATH 找', async () => {
    const result = await resolveCodexPath()
    expect(typeof result === 'string' || result === null).toBe(true)
  })
})
