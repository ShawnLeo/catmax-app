// @vitest-environment node
/**
 * Bug A regression test：BackendManager.applySettings 必须把 settings.json 的
 * defaultBackend 应用到 currentBackendId（之前完全没被读取，导致 defaultBackend=claude
 * 的用户启动后 currentBackendId 仍是 'codex'，触发 CodexAdapter.initialize 超时）。
 *
 * 同时验证 backendPaths 注入到 adapter 的 binaryPath。
 */
import { describe, expect, test, vi } from 'vitest'

// mock context——避免拉起真的 db / settingsStore（applySettings 不依赖 ctx，
// 但 manager.ts 静态 import 了 ctx）
vi.mock('@main/context', () => ({
  ctx: {
    broadcast: vi.fn(),
  },
}))

// 必须在 mock 之后 import
const { BackendManager } = await import('@main/backend/manager')
const { appSettingsSchema } = await import('@shared/settings-schema')
import type { AppSettings } from '@shared/settings-schema'

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return appSettingsSchema.parse({
    defaultBackend: 'codex',
    backendPaths: { codex: null, claude: null },
    ...overrides,
  })
}

describe('Bug A: BackendManager.applySettings', () => {
  test('applySettings 把 defaultBackend 应用到 currentBackendId', () => {
    const mgr = new BackendManager()
    expect(mgr.getCurrentId()).toBe('codex') // 初始默认

    mgr.applySettings(makeSettings({ defaultBackend: 'claude' }))
    expect(mgr.getCurrentId()).toBe('claude')
  })

  test('applySettings 不主动 initialize（lazy）—— 切换不阻塞', () => {
    const mgr = new BackendManager()
    // initialize 是异步且会 spawn 真子进程；applySettings 必须同步完成
    const start = Date.now()
    mgr.applySettings(makeSettings({ defaultBackend: 'claude' }))
    const elapsed = Date.now() - start
    // <50ms = 没 spawn 任何子进程（spawn 至少要几 ms，且会失败因为没 mock spawner）
    expect(elapsed).toBeLessThan(50)
    expect(mgr.getCurrentId()).toBe('claude')
  })

  test('applySettings 多次调用幂等', () => {
    const mgr = new BackendManager()
    mgr.applySettings(makeSettings({ defaultBackend: 'claude' }))
    expect(mgr.getCurrentId()).toBe('claude')
    mgr.applySettings(makeSettings({ defaultBackend: 'claude' }))
    expect(mgr.getCurrentId()).toBe('claude')
  })

  test('applySettings 把 backendPaths 注入 codex adapter', () => {
    const mgr = new BackendManager()
    // 间接验证：applySettings 后，healthCheck 调 `codex --version` 时会用我们的路径。
    // 直接拿 adapter 检查更可靠——但 adapter 是 private。
    // 改用 healthCheck 路径：自定义一个不存在的路径，healthCheck 必须报错。
    mgr.applySettings(
      makeSettings({
        backendPaths: { codex: '/nonexistent/codex-binary', claude: null },
      }),
    )

    return mgr.getStatus('codex').then((status) => {
      // 自定义路径不存在 → healthCheck 返回 not-installed 或 spawn-failed
      // （取决于 execSync 行为；关键是它不会真的调用系统 PATH 上的 codex）
      expect(status.available).toBe(false)
      expect(['not-installed', 'spawn-failed']).toContain(status.error)
    })
  })

  test('applySettings 后 getCurrent 返回 claude adapter（listSessions 不再误触发 codex）', async () => {
    const mgr = new BackendManager()
    mgr.applySettings(makeSettings({ defaultBackend: 'claude' }))

    const current = mgr.getCurrent()
    expect(current.id).toBe('claude')
    // claude listSessions 返回空数组，不会卡住
    const sessions = await mgr.listSessions('/tmp')
    expect(sessions).toEqual([])
  })
})
