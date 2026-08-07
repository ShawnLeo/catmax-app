// @vitest-environment node
/**
 * Bug F-2 回归测试：getSessionDetail 拿到 aiTitle 时回写 db 并返回。
 *
 * Bug 场景：claude jsonl 里有 aiTitle（claude 自动生成的会话标题），但 db 里 title
 * 一直是空——侧边栏永远显示 "(新会话)"。修复后 getSessionDetail 会把 aiTitle 回写
 * db + 返回给 renderer。
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test, afterEach, vi } from 'vitest'

// 用 vi.hoisted 让 spy 数组在 mock 工厂里可访问（vi.mock 是 hoisted）
const { updateTitleCalls } = vi.hoisted(() => ({ updateTitleCalls: [] as Array<[string, string]> }))
// 每个 test 用 mockImplementation/mockResolvedValueOnce 控制返回值；这是 fallback 默认
const { defaultAiTitle } = vi.hoisted(() => ({
  defaultAiTitle: { value: 'Auto Title from Backend' },
}))

vi.mock('@main/context', async () => {
  const { DatabaseService } = await import('@main/service/database')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const tempDir = mkdtempSync(join(tmpdir(), 'catmax-session-detail-'))
  const db = new DatabaseService(join(tempDir, 'test.db'))
  db.migrate()

  // Proxy 包装：updateSessionTitle 调用记到 spy 上 + 透传给真 db
  const wrappedDb = new Proxy(db, {
    get(target, prop) {
      if (prop === 'updateSessionTitle') {
        return (id: string, title: string) => {
          updateTitleCalls.push([id, title])
          return target.updateSessionTitle(id, title)
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (target as any)[prop]
    },
  })

  return {
    ctx: {
      db: wrappedDb,
      backendManager: {
        getCurrentId: vi.fn(() => 'claude'),
        // 每次返回唯一的 backendThreadId（db 有 UNIQUE(backend, backend_thread_id) 约束）
        startSession: vi.fn(() =>
          Promise.resolve({
            sessionId: crypto.randomUUID(),
            backendThreadId: 'thread-' + crypto.randomUUID(),
          }),
        ),
        // 默认返回 defaultAiTitle.value，单测可用 mockResolvedValueOnce 覆盖
        getHistory: vi.fn(() =>
          Promise.resolve({
            messages: [],
            aiTitle: defaultAiTitle.value,
          }),
        ),
      },
    },
    __testTempDir: tempDir,
    __getHistoryMock: () => null, // 占位，下面通过 ctxModule 直接拿
  }
})

// mock 工厂返回的是手写的部分 ctx 形状，故意不匹配真实 Context class（缺 settingsStore/authStore/
// ptyManager 等），后面全靠动态属性访问，没法给一个不会跟 mock 走样的结构类型。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctxModule = (await import('@main/context')) as any
const { getSessionDetail } = await import('@main/ipc/domains/session/handlers')

afterEach(() => {
  // 清理 spy + 重置 default
  updateTitleCalls.splice(0, updateTitleCalls.length)
  defaultAiTitle.value = 'Auto Title from Backend'
  // mockReset getHistory 的 Once 队列
  ctxModule.ctx.backendManager.getHistory.mockClear()
  const tempDir = ctxModule.__testTempDir
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

function makeSession(title: string | null): string {
  const db = ctxModule.ctx.db
  const now = Date.now()
  const wsId = randomUUID()
  db.insertWorkspace({
    id: wsId,
    path: mkdtempSync(join(tmpdir(), 'ws-')),
    name: 'ws-' + wsId.slice(0, 8),
    folders: [],
    preferredEditor: null,
    lastOpenedAt: now,
    createdAt: now,
  })
  const sessionId = randomUUID()
  db.insertSession({
    id: sessionId,
    backend: 'claude',
    backendThreadId: 'thread-' + sessionId.slice(0, 8),
    workspaceId: wsId,
    title,
    model: null,
    effort: null,
    permissionMode: null,
    turnCount: 0,
    createdAt: now,
    lastActiveAt: now,
  })
  return sessionId
}

describe('Bug F-2: getSessionDetail aiTitle 回写 db', () => {
  test('后端返回 aiTitle 且 db 里 title 为空时，回写 + 返回 session.title = aiTitle', async () => {
    const sessionId = makeSession(null)
    const result = await getSessionDetail({ sessionId })

    expect(updateTitleCalls).toContainEqual([sessionId, 'Auto Title from Backend'])
    expect(result.session.title).toBe('Auto Title from Backend')
    expect(result.aiTitle).toBe('Auto Title from Backend')
  })

  test('后端没返回 aiTitle 时不动 db', async () => {
    ctxModule.ctx.backendManager.getHistory.mockResolvedValueOnce({
      messages: [],
      aiTitle: null,
    })
    const sessionId = makeSession(null)
    const result = await getSessionDetail({ sessionId })

    expect(updateTitleCalls).toHaveLength(0)
    expect(result.session.title).toBeNull()
  })

  test('aiTitle 与 db 里已有 title 相同时不重复回写', async () => {
    const sessionId = makeSession('Auto Title from Backend') // 已有相同标题
    await getSessionDetail({ sessionId })

    expect(updateTitleCalls).toHaveLength(0)
  })
})

describe('Bug F-3: createSession 用 initialPrompt 作为 title（claude -p 不生成 aiTitle 的 fallback）', () => {
  test('createSession 收到 initialPrompt 时，db.title 立即写入 slice(0,50)', async () => {
    const { createSession } = await import('@main/ipc/domains/session/handlers')
    const db = ctxModule.ctx.db

    const now = Date.now()
    const wsId = randomUUID()
    db.insertWorkspace({
      id: wsId,
      path: mkdtempSync(join(tmpdir(), 'ws-create-')),
      name: 'ws-create',
      folders: [],
      preferredEditor: null,
      lastOpenedAt: now,
      createdAt: now,
    })

    const { sessionId } = await createSession({
      workspaceId: wsId,
      backend: 'claude',
      cwd: '/tmp',
      initialPrompt: '讲个 30 秒能读完的程序员笑话。不要调用任何工具。',
    })

    const session = db.findSessionById(sessionId)
    expect(session?.title).toBe('讲个 30 秒能读完的程序员笑话。不要调用任何工具。'.slice(0, 50))
  })

  test('createSession 没有 initialPrompt 时 title 为 null', async () => {
    const { createSession } = await import('@main/ipc/domains/session/handlers')
    const db = ctxModule.ctx.db

    const now = Date.now()
    const wsId = randomUUID()
    db.insertWorkspace({
      id: wsId,
      path: mkdtempSync(join(tmpdir(), 'ws-create2-')),
      name: 'ws-create2',
      folders: [],
      preferredEditor: null,
      lastOpenedAt: now,
      createdAt: now,
    })

    const { sessionId } = await createSession({
      workspaceId: wsId,
      backend: 'claude',
      cwd: '/tmp',
    })

    const session = db.findSessionById(sessionId)
    expect(session?.title).toBeNull()
  })
})
