// @vitest-environment node
/**
 * Bug B regression test：reconcileSessions 必须在后端 listSessions 失败时不抛错。
 *
 * Bug 场景：用户切到 claude，但 main 的 currentBackendId 还是 codex（Bug A 之前），
 * reconcileSessions 调 ctx.backendManager.listSessions() 触发 CodexAdapter.initialize()
 * 30s 超时然后抛 BackendError('timeout')，导致 UI "session.reconcile" 报错。
 *
 * 现在：listSessions 失败时跳过 backend sync，返回空 added/removed（不阻塞 UI）。
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test, afterEach, vi } from 'vitest'

// mock ctx：包含真实 db（tempDir）+ 一个会抛错的 backendManager
vi.mock('@main/context', async () => {
  const { DatabaseService } = await import('@main/service/database')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const tempDir = mkdtempSync(join(tmpdir(), 'catmax-session-reconcile-'))
  const db = new DatabaseService(join(tempDir, 'test.db'))
  db.migrate()
  return {
    ctx: {
      db,
      // 模拟 codex initialize timeout：listSessions 抛错
      backendManager: {
        listSessions: vi.fn().mockRejectedValue(new Error('request initialize timed out')),
        getCurrentId: vi.fn().mockReturnValue('codex'),
      },
    },
    __testTempDir: tempDir,
  }
})

const ctxModule = (await import('@main/context')) as any
const { reconcileSessions } = await import('@main/ipc/domains/session/handlers')

afterEach(() => {
  const tempDir = ctxModule.__testTempDir
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

describe('Bug B: reconcileSessions 容错', () => {
  test('backendManager.listSessions 抛错时 reconcile 不传播错误', async () => {
    const db = ctxModule.ctx.db
    const now = Date.now()
    db.insertWorkspace({
      id: randomUUID(),
      path: mkdtempSync(join(tmpdir(), 'ws-')),
      name: 'test-ws',
      preferredEditor: null,
      lastOpenedAt: now,
      createdAt: now,
    })
    const workspace = db.listWorkspaces()[0]

    // 即使 listSessions 抛 "request initialize timed out"，reconcile 也应该 swallow
    const result = await reconcileSessions({ workspaceId: workspace.id })

    expect(result).toBeDefined()
    expect(result.added).toEqual([])
    expect(result.removed).toEqual([])
  })

  test('workspace 不存在时仍抛 SessionError（不 swallow 业务错误）', async () => {
    await expect(reconcileSessions({ workspaceId: 'definitely-does-not-exist' })).rejects.toThrow(
      /workspace not found/,
    )
  })
})
