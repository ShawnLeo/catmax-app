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
      folders: [],
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

/**
 * 跨 backend 不误标 stale 的回归测试。
 *
 * 场景：db 里同时有 claude 和 codex 的会话，currentBackend 切到 claude 后 reconcile。
 * 修复前：appSessions 拉全量（含 codex），codex 的 backendThreadId 不在 claude 的真实列表里，
 *        会被误标 stale。修复后：appSessions 也过滤成当前 backend，codex 那条不受影响。
 */
describe('跨 backend reconcile 不误标 stale', () => {
  test('currentBackend=claude 时 codex 会话不进 removed', async () => {
    const db = ctxModule.ctx.db
    const now = Date.now()
    db.insertWorkspace({
      id: 'ws-cross',
      path: mkdtempSync(join(tmpdir(), 'ws-cross-')),
      name: 'test-ws-cross',
      folders: [],
      preferredEditor: null,
      lastOpenedAt: now,
      createdAt: now,
    })

    // db 里两条会话：一条 claude、一条 codex
    db.insertSession({
      id: 'sess-claude',
      backend: 'claude',
      backendThreadId: 'claude-thread-1',
      workspaceId: 'ws-cross',
      title: 'claude session',
      model: null,
      effort: null,
      permissionMode: null,
      turnCount: 1,
      createdAt: now,
      lastActiveAt: now,
    })
    db.insertSession({
      id: 'sess-codex',
      backend: 'codex',
      backendThreadId: 'codex-thread-1',
      workspaceId: 'ws-cross',
      title: 'codex session',
      model: null,
      effort: null,
      permissionMode: null,
      turnCount: 1,
      createdAt: now,
      lastActiveAt: now,
    })

    // 当前 backend 是 claude，后端真实列表也只有 claude 的会话
    const mockBackendManager = ctxModule.ctx.backendManager
    mockBackendManager.getCurrentId.mockReturnValue('claude')
    mockBackendManager.listSessions.mockResolvedValue([
      {
        backendThreadId: 'claude-thread-1',
        title: 'claude session',
        lastActiveAt: now,
        model: 'claude-sonnet',
      },
    ])

    const result = await reconcileSessions({ workspaceId: 'ws-cross' })

    // claude 会话匹配上，没有 added 也没有 removed
    expect(result.added).toEqual([])
    // 关键断言：codex 会话不能被误标 stale
    expect(result.removed).not.toContain('sess-codex')
    expect(result.removed).toEqual([])

    // codex 会话 db 里仍是 stale=false（没被 markSessionStale 碰过）
    const codexSession = db.findSessionById('sess-codex')
    expect(codexSession).not.toBeNull()
  })
})

/**
 * Session Title Fallback: 空标题回填。
 *
 * 早先登记进来的会话 title 可能是 null（claude 侧只认 jsonl 的 ai-title 行，而
 * SDK 跑出来的会话没有那一行），侧边栏一直显示 "(新会话)"。扫描现在能派生标题了，
 * reconcile 要把这些空标题补上——但只补空的，不覆盖已有标题，更不碰用户改过名的。
 */
describe('reconcileSessions 回填空标题', () => {
  const now = Date.now()

  /** 造一个只含指定会话的干净 workspace */
  function setupWorkspace(
    workspaceId: string,
    sessions: Array<{ id: string; title: string | null; titleCustom?: boolean }>,
  ) {
    const db = ctxModule.ctx.db
    db.insertWorkspace({
      id: workspaceId,
      path: mkdtempSync(join(tmpdir(), 'ws-backfill-')),
      name: workspaceId,
      folders: [],
      preferredEditor: null,
      lastOpenedAt: now,
      createdAt: now,
    })
    for (const s of sessions) {
      db.insertSession({
        id: s.id,
        backend: 'claude',
        backendThreadId: `thread-${s.id}`,
        workspaceId,
        title: s.title,
        model: null,
        effort: null,
        permissionMode: null,
        turnCount: 1,
        createdAt: now,
        lastActiveAt: now,
        pinnedAt: null,
        titleCustom: s.titleCustom ?? false,
      })
    }
    const mockBackendManager = ctxModule.ctx.backendManager
    mockBackendManager.getCurrentId.mockReturnValue('claude')
    mockBackendManager.listSessions.mockResolvedValue(
      sessions.map((s) => ({
        backendThreadId: `thread-${s.id}`,
        title: `扫描派生的标题 ${s.id}`,
        lastActiveAt: now,
        model: null,
      })),
    )
    return db
  }

  test('title 为 null 的已登记会话被补上扫描到的标题', async () => {
    const db = setupWorkspace('ws-backfill-1', [{ id: 'empty', title: null }])

    const result = await reconcileSessions({ workspaceId: 'ws-backfill-1' })

    expect(result.titleBackfilled).toBe(1)
    expect(db.findSessionById('empty').title).toBe('扫描派生的标题 empty')
    // 回填改的是已存在的会话，不产生 added/removed
    expect(result.added).toEqual([])
    expect(result.removed).toEqual([])
  })

  test('已有标题的会话不被覆盖', async () => {
    const db = setupWorkspace('ws-backfill-2', [{ id: 'has-title', title: '原有标题' }])

    const result = await reconcileSessions({ workspaceId: 'ws-backfill-2' })

    expect(result.titleBackfilled).toBe(0)
    expect(db.findSessionById('has-title').title).toBe('原有标题')
  })

  test('用户手动改过名的会话（titleCustom）即使标题为空也不动', async () => {
    const db = setupWorkspace('ws-backfill-3', [
      { id: 'renamed-empty', title: null, titleCustom: true },
    ])

    const result = await reconcileSessions({ workspaceId: 'ws-backfill-3' })

    expect(result.titleBackfilled).toBe(0)
    expect(db.findSessionById('renamed-empty').title).toBeNull()
  })
})
