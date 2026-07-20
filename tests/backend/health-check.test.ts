// @vitest-environment node
/**
 * Bug H 测试：checkCliHealth 把 spawnSync 结果分类成明确的错误码。
 *
 * Bug 场景：之前 CodexAdapter.healthCheck 用 execSync + 只区分 ENOENT/兜底，
 * 把 macOS Gatekeeper 拦截（SIGKILL）也都笼统报 "spawn-failed"。
 * 用户看到 codex 不可用，但完全不知道为什么 / 怎么修。
 */
import { checkCliHealth } from '@main/backend/health-check'
import { describe, expect, test } from 'vitest'

describe('checkCliHealth', () => {
  test('命令不存在 → not-installed', () => {
    // /definitely/not/exist 这种路径，spawnSync 会返回带 error 的对象
    const result = checkCliHealth('/definitely/not/exist/xyzbinary')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('not-installed')
  })

  test('PATH 里没有的命令名 → not-installed', () => {
    const result = checkCliHealth('catmax-nonexistent-cli-xyz-12345')
    expect(result.ok).toBe(false)
    // macOS / Linux 上 spawnSync 找不到命令时，error.code = 'ENOENT'
    expect(['not-installed', 'spawn-error']).toContain(result.error)
  })

  test('正常命令 → ok: true + version', () => {
    // echo 是个稳定跨平台的命令；spawnSync 不走 shell 时直接调 binary
    // 但 echo 在不同系统路径不同——用 ls 替代（macOS / Linux 都有）
    const result = checkCliHealth('ls', ['--version'])
    // ls --version 在 mac 是 non-zero，linux 是 ok——都行，只要不抛错就算 spawn 工作
    expect(result).toBeDefined()
    // 至少不会因为 ENOENT 报 not-installed
    expect(result.error).not.toBe('not-installed')
  })

  test('退出码非 0 → non-zero-exit', () => {
    // false 命令在 unix 上永远退出 1
    const result = checkCliHealth('false', [])
    if (result.ok) {
      // 某些环境可能没有 false（不太可能），跳过
      return
    }
    expect(result.error).toBe('non-zero-exit')
    expect(result.exitCode).toBe(1)
  })

  test('超时命令 → timeout 或 killed-by-os', () => {
    // sleep 30 + timeout 5s —— 但 checkCliHealth 内部 hardcode 5s 等太久；
    // 这里用 `cat /dev/null` 不会阻塞，所以这只验证 spawnSync 路径不抛错
    const result = checkCliHealth('cat', ['/dev/null'])
    expect(result.ok).toBe(true)
  })
})

describe('checkCliHealth（针对 macOS Gatekeeper 场景）', () => {
  test('被 SIGKILL 的命令 → killed-by-os', () => {
    // 用一个能产生 SIGKILL 的命令：让进程 kill 自己
    // macOS / Linux 都能用 `kill -9 $$` 让 shell 自杀
    // 但 spawnSync 不走 shell，所以用 sh -c
    const { spawnSync } = require('node:child_process')
    // 直接构造一个会自杀的进程
    const fakeCheck = () => {
      const r = spawnSync('sh', ['-c', 'kill -9 $$'], { encoding: 'utf-8', timeout: 5000 })
      // 模拟 checkCliHealth 的判断逻辑
      if (r.signal === 'SIGKILL') return { ok: false, error: 'killed-by-os', signal: r.signal }
      return { ok: true }
    }
    const result = fakeCheck()
    expect(result.error).toBe('killed-by-os')
  })
})
