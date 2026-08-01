import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DatabaseService } from '@main/service/database'
import type { MessagePreview, SessionRecord, TurnRunRecord, WorkspaceRecord } from '@shared/domain'
import Database from 'better-sqlite3'
import { describe, expect, test, beforeEach, afterEach } from 'vitest'

let db: DatabaseService
let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'catmax-test-'))
  db = new DatabaseService(join(tempDir, 'test.db'))
  db.migrate()
})

afterEach(() => {
  db.close()
  rmSync(tempDir, { recursive: true, force: true })
})

function makeWorkspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: 'test-id',
    path: '/tmp/test-workspace',
    name: 'test-workspace',
    preferredEditor: null,
    lastOpenedAt: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('DatabaseService', () => {
  test('migrate 创建表（重复执行不报错）', () => {
    expect(() => db.migrate()).not.toThrow()
  })

  /**
   * schema.sql 全是 CREATE TABLE IF NOT EXISTS——老库里 sessions 表已经存在，
   * 重跑 schema 不会给它加新列，只能靠 migrateAddColumns 的守卫 ALTER。
   * 这条路径在测试里最容易被漏掉（新建的库天然带全部列），但线上每个用户都走它。
   */
  test('migrate 给老库补 pinned_at / title_custom 列，且不动已有数据', () => {
    const legacyPath = join(tempDir, 'legacy.db')
    // 手工建一张"补列之前"的 sessions 表并塞一行——绕过 DatabaseService 直接写，
    // 否则拿不到"老库"的状态（它的 migrate 一开就把新列补上了）
    const seed = new Database(legacyPath)
    seed.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, backend TEXT NOT NULL, backend_thread_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL, title TEXT, model TEXT, effort TEXT,
        permission_mode TEXT, turn_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
        UNIQUE(backend, backend_thread_id)
      );
      INSERT INTO sessions (id, backend, backend_thread_id, workspace_id, title,
        turn_count, created_at, last_active_at)
      VALUES ('old-1', 'codex', 'thr-old', 'ws-1', '老会话', 3, 1000, 2000);
    `)
    seed.close()

    const upgraded = new DatabaseService(legacyPath)
    expect(() => upgraded.migrate()).not.toThrow()

    const found = upgraded.findSessionById('old-1')
    expect(found?.title).toBe('老会话')
    expect(found?.turnCount).toBe(3)
    // 补出来的列取默认值：未置顶 + 标题未被用户改过
    expect(found?.pinnedAt).toBeNull()
    expect(found?.titleCustom).toBe(false)

    // 补列是幂等的——每次启动都会跑一遍
    expect(() => upgraded.migrate()).not.toThrow()
    upgraded.close()
  })

  test('insertWorkspace + findWorkspaceById', () => {
    const ws = makeWorkspace({ id: 'ws-1', path: '/a/b' })
    db.insertWorkspace(ws)
    const found = db.findWorkspaceById('ws-1')
    expect(found).toEqual(ws)
  })

  test('findWorkspaceByPath', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1', path: '/a/b' }))
    expect(db.findWorkspaceByPath('/a/b')?.id).toBe('ws-1')
    expect(db.findWorkspaceByPath('/not/exist')).toBeNull()
  })

  test('listWorkspaces 按 lastOpenedAt 倒序', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1', path: '/a', lastOpenedAt: 1000 }))
    db.insertWorkspace(makeWorkspace({ id: 'ws-2', path: '/b', lastOpenedAt: 3000 }))
    db.insertWorkspace(makeWorkspace({ id: 'ws-3', path: '/c', lastOpenedAt: 2000 }))

    const list = db.listWorkspaces()
    expect(list.map((w) => w.id)).toEqual(['ws-2', 'ws-3', 'ws-1'])
  })

  test('path 唯一约束（重复插入抛错）', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1', path: '/dup' }))
    expect(() => db.insertWorkspace(makeWorkspace({ id: 'ws-2', path: '/dup' }))).toThrow()
  })

  test('updateWorkspaceName', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1' }))
    db.updateWorkspaceName('ws-1', '新名字')
    expect(db.findWorkspaceById('ws-1')?.name).toBe('新名字')
  })

  test('updateWorkspaceEditor', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1' }))
    db.updateWorkspaceEditor('ws-1', 'vscode')
    expect(db.findWorkspaceById('ws-1')?.preferredEditor).toBe('vscode')
  })

  test('deleteWorkspace', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1' }))
    db.deleteWorkspace('ws-1')
    expect(db.findWorkspaceById('ws-1')).toBeNull()
  })

  test('app_state setState/getState', () => {
    db.setState('foo', 'bar')
    expect(db.getState('foo')).toBe('bar')
    db.setState('foo', 'baz') // upsert
    expect(db.getState('foo')).toBe('baz')
  })

  test('app_state deleteState', () => {
    db.setState('foo', 'bar')
    db.deleteState('foo')
    expect(db.getState('foo')).toBeNull()
  })
})

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess-1',
    backend: 'codex',
    backendThreadId: 'thr_1',
    workspaceId: 'ws-1',
    title: 'test session',
    model: 'gpt-5',
    effort: 'medium',
    permissionMode: 'default',
    turnCount: 0,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    pinnedAt: null,
    titleCustom: false,
    ...overrides,
  }
}

describe('DatabaseService Session', () => {
  test('insertSession + findSessionById', () => {
    // 先插 workspace（外键约束）
    db.insertWorkspace(makeWorkspace({ id: 'ws-1', path: '/tmp/test-ws-1' }))
    const session = makeSession({ workspaceId: 'ws-1' })
    db.insertSession(session)
    const found = db.findSessionById(session.id)
    expect(found).toEqual(session)
  })

  test('listSessions 按 lastActiveAt 倒序', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1', path: '/tmp/test-ws-1' }))
    db.insertSession(
      makeSession({ id: 's1', backendThreadId: 't1', workspaceId: 'ws-1', lastActiveAt: 1000 }),
    )
    db.insertSession(
      makeSession({ id: 's2', backendThreadId: 't2', workspaceId: 'ws-1', lastActiveAt: 3000 }),
    )
    db.insertSession(
      makeSession({ id: 's3', backendThreadId: 't3', workspaceId: 'ws-1', lastActiveAt: 2000 }),
    )
    const list = db.listSessions('ws-1')
    expect(list.map((s) => s.id)).toEqual(['s2', 's3', 's1'])
  })

  test('listSessions 传 backend 时只返回该 backend 的会话', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1', path: '/tmp/test-ws-1' }))
    db.insertSession(
      makeSession({
        id: 'c1',
        backend: 'claude',
        backendThreadId: 'ct1',
        workspaceId: 'ws-1',
        lastActiveAt: 1000,
      }),
    )
    db.insertSession(
      makeSession({
        id: 'x1',
        backend: 'codex',
        backendThreadId: 'xt1',
        workspaceId: 'ws-1',
        lastActiveAt: 2000,
      }),
    )
    db.insertSession(
      makeSession({
        id: 'c2',
        backend: 'claude',
        backendThreadId: 'ct2',
        workspaceId: 'ws-1',
        lastActiveAt: 3000,
      }),
    )
    // 传 claude 只返回 claude 的，按 lastActiveAt 倒序
    const claudeList = db.listSessions('ws-1', 'claude')
    expect(claudeList.map((s) => s.id)).toEqual(['c2', 'c1'])
    // 传 codex 只返回 codex 的
    const codexList = db.listSessions('ws-1', 'codex')
    expect(codexList.map((s) => s.id)).toEqual(['x1'])
    // 不传 backend 仍返回全量（向后兼容，用于 reconcile/scanImportable）
    const allList = db.listSessions('ws-1')
    expect(allList.map((s) => s.id)).toEqual(['c2', 'x1', 'c1'])
  })

  test('UNIQUE(backend, backend_thread_id)', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1', path: '/tmp/test-ws-1' }))
    db.insertSession(makeSession({ id: 's1', backendThreadId: 'dup', workspaceId: 'ws-1' }))
    expect(() =>
      db.insertSession(makeSession({ id: 's2', backendThreadId: 'dup', workspaceId: 'ws-1' })),
    ).toThrow()
  })

  test('bumpSessionTurn 累加 turnCount + 更新时间', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1', path: '/tmp/test-ws-1' }))
    db.insertSession(makeSession({ id: 's1', workspaceId: 'ws-1', turnCount: 0 }))
    db.bumpSessionTurn('s1', 9999)
    db.bumpSessionTurn('s1', 10000)
    const found = db.findSessionById('s1')
    expect(found?.turnCount).toBe(2)
    expect(found?.lastActiveAt).toBe(10000)
  })

  test('bumpSessionTurn COALESCE 保留旧值', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1', path: '/tmp/test-ws-1' }))
    db.insertSession(
      makeSession({ id: 's1', workspaceId: 'ws-1', model: 'gpt-5', effort: 'medium' }),
    )
    db.bumpSessionTurn('s1', Date.now(), undefined, undefined, undefined)
    const found = db.findSessionById('s1')
    expect(found?.model).toBe('gpt-5')
    expect(found?.effort).toBe('medium')
  })

  test('deleteSession', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1', path: '/tmp/test-ws-1' }))
    db.insertSession(makeSession({ id: 's1', workspaceId: 'ws-1' }))
    db.deleteSession('s1')
    expect(db.findSessionById('s1')).toBeNull()
  })

  test('删除 workspace 级联删 session（FK CASCADE）', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1', path: '/tmp/test-ws-1' }))
    db.insertSession(makeSession({ id: 's1', workspaceId: 'ws-1' }))
    db.deleteWorkspace('ws-1')
    expect(db.findSessionById('s1')).toBeNull()
  })

  // Session Pin
  test('setSessionPinned 让置顶会话排在前面，组内各自按时间倒序', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1', path: '/tmp/test-ws-1' }))
    for (const [id, lastActiveAt] of [
      ['s1', 1000],
      ['s2', 3000],
      ['s3', 2000],
    ] as const) {
      db.insertSession(
        makeSession({ id, backendThreadId: `t-${id}`, workspaceId: 'ws-1', lastActiveAt }),
      )
    }
    // 未置顶时纯按活跃时间
    expect(db.listSessions('ws-1').map((s) => s.id)).toEqual(['s2', 's3', 's1'])

    // 置顶最不活跃的那条——它应该跳到最上面，其余顺序不变
    db.setSessionPinned('s1', true)
    expect(db.listSessions('ws-1').map((s) => s.id)).toEqual(['s1', 's2', 's3'])
    expect(db.findSessionById('s1')?.pinnedAt).not.toBeNull()

    // 再置顶一条：后置顶的排在先置顶的前面
    db.setSessionPinned('s3', true)
    expect(db.listSessions('ws-1').map((s) => s.id)).toEqual(['s3', 's1', 's2'])

    // 取消置顶后回到活跃时间序
    db.setSessionPinned('s1', false)
    db.setSessionPinned('s3', false)
    expect(db.listSessions('ws-1').map((s) => s.id)).toEqual(['s2', 's3', 's1'])
    expect(db.findSessionById('s1')?.pinnedAt).toBeNull()
  })

  // Session Rename
  test('renameSession 之后后端自动标题不再覆盖', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1', path: '/tmp/test-ws-1' }))
    db.insertSession(makeSession({ id: 's1', workspaceId: 'ws-1', title: '原标题' }))

    // 用户没改过标题时，后端 aiTitle 正常回写
    db.updateSessionTitle('s1', 'AI 起的标题')
    expect(db.findSessionById('s1')?.title).toBe('AI 起的标题')
    expect(db.findSessionById('s1')?.titleCustom).toBe(false)

    // 用户手动重命名
    db.renameSession('s1', '我的名字')
    expect(db.findSessionById('s1')?.title).toBe('我的名字')
    expect(db.findSessionById('s1')?.titleCustom).toBe(true)

    // 此后 aiTitle 回写是 no-op——否则用户改完名，下一个 turn 结束就被冲掉
    db.updateSessionTitle('s1', 'AI 又起了一个')
    expect(db.findSessionById('s1')?.title).toBe('我的名字')
  })
})

describe('DatabaseService Message', () => {
  test('insertMessage + listMessages', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1', path: '/tmp/test-ws-1' }))
    db.insertSession(makeSession({ id: 's1', workspaceId: 'ws-1' }))
    db.insertMessage({
      id: 'm1',
      sessionId: 's1',
      turnId: 'turn-1',
      role: 'user',
      textPreview: 'hello',
      toolCallCount: 0,
      createdAt: 1000,
    })
    db.insertMessage({
      id: 'm2',
      sessionId: 's1',
      turnId: 'turn-1',
      role: 'assistant',
      textPreview: 'hi there',
      toolCallCount: 2,
      createdAt: 2000,
    })
    const list = db.listMessages('s1')
    expect(list).toHaveLength(2)
    expect(list[0]!.role).toBe('user')
    expect(list[1]!.toolCallCount).toBe(2)
  })

  test('删除 session 级联删 messages', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1', path: '/tmp/test-ws-1' }))
    db.insertSession(makeSession({ id: 's1', workspaceId: 'ws-1' }))
    db.insertMessage({
      id: 'm1',
      sessionId: 's1',
      turnId: 'turn-1',
      role: 'user',
      textPreview: 'x',
      toolCallCount: 0,
      createdAt: 1,
    } satisfies MessagePreview)
    db.deleteSession('s1')
    expect(db.listMessages('s1')).toHaveLength(0)
  })
})

describe('DatabaseService Turn Run', () => {
  function makeTurnRun(overrides: Partial<TurnRunRecord> = {}): TurnRunRecord {
    return {
      id: 'turn-1',
      sessionId: 'session-1',
      backend: 'claude',
      backendTurnId: 'backend-turn-1',
      status: 'running',
      backgroundTasks: [
        {
          taskId: 'agent-a',
          toolUseId: 'tool-a',
          status: 'running',
          stats: { agentId: 'agent-a', status: 'running' },
        },
      ],
      createdAt: 100,
      startedAt: 110,
      lastEventAt: 120,
      completedAt: null,
      error: null,
      ...overrides,
    }
  }

  test('upsertTurnRun 持久化状态和后台任务快照', () => {
    db.upsertTurnRun(makeTurnRun())
    db.upsertTurnRun(
      makeTurnRun({
        status: 'completed',
        completedAt: 200,
        backgroundTasks: [
          {
            taskId: 'agent-a',
            toolUseId: 'tool-a',
            status: 'completed',
            summary: '完成',
            stats: { agentId: 'agent-a', status: 'completed', totalTokens: 42 },
          },
        ],
      }),
    )

    expect(db.listTurnRuns('session-1')).toEqual([
      expect.objectContaining({
        id: 'turn-1',
        status: 'completed',
        completedAt: 200,
        backgroundTasks: [
          expect.objectContaining({
            taskId: 'agent-a',
            status: 'completed',
            stats: expect.objectContaining({ totalTokens: 42 }),
          }),
        ],
      }),
    ])
  })

  test('listRecoverableTurnRuns 只返回非终态', () => {
    db.upsertTurnRun(makeTurnRun({ id: 'running', status: 'running' }))
    db.upsertTurnRun(makeTurnRun({ id: 'queued', status: 'queued', startedAt: null }))
    db.upsertTurnRun(makeTurnRun({ id: 'done', status: 'completed', completedAt: 200 }))

    expect(
      db
        .listRecoverableTurnRuns()
        .map((record) => record.id)
        .sort(),
    ).toEqual(['queued', 'running'])
  })

  test('deleteTurnRunsCompletedBefore 只清理过期终态', () => {
    db.upsertTurnRun(makeTurnRun({ id: 'old', status: 'completed', completedAt: 100 }))
    db.upsertTurnRun(makeTurnRun({ id: 'new', status: 'completed', completedAt: 300 }))
    db.upsertTurnRun(makeTurnRun({ id: 'running', status: 'running', completedAt: null }))

    expect(db.deleteTurnRunsCompletedBefore(200)).toBe(1)
    expect(db.listTurnRuns().map((record) => record.id)).toEqual(['new', 'running'])
  })
})
