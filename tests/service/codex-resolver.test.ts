// @vitest-environment node
import { describe, expect, test, vi } from 'vitest'

// codex-resolver 在模块顶层 import electron（app.getPath，用于定位一键安装目录），
// vitest 里没有 Electron runtime，mock 掉才能 import 到纯函数。
vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent/catmax-test-userdata' },
}))

const { resolveCodexPath } = await import('@main/service/codex-resolver')

describe('resolveCodexPath', () => {
  test('自定义路径存在时返回', async () => {
    // /bin/cat 是肯定存在的（不是真的 codex，但测路径解析逻辑）
    const result = await resolveCodexPath('/bin/cat')
    expect(result).toBe('/bin/cat')
  })

  test('自定义路径不存在时 fallback 到自动发现', async () => {
    // 路径不存在，会走 which/npm/常见目录/nvm 的自动发现链；
    // 结果取决于运行测试的机器是否装了 codex，这里只验证不抛错。
    const result = await resolveCodexPath('/nonexistent/path/xyz')
    expect(typeof result === 'string' || result === null).toBe(true)
  })

  test('不传自定义路径，走自动发现', async () => {
    const result = await resolveCodexPath()
    expect(typeof result === 'string' || result === null).toBe(true)
  })
})
