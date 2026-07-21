import { randomUUID } from 'node:crypto'

import { encodeCwdToProjectDir } from '@main/backend/claude/jsonl-reader'
import { ctx } from '@main/context'
import { logger } from '@main/service/logger'
import type { SessionSummary } from '@shared/backend/types'
import type { BackendId } from '@shared/constants'
import type { SessionRecord, SessionView, WorkspaceRecord } from '@shared/domain'
import type {
  CreateSessionArgs,
  ImportSessionArgs,
  ImportSessionsResult,
  ImportableSession,
  ScanImportableResult,
} from '@shared/ipc/session'

const log = logger.domain('session-handler')

export class SessionError extends Error {
  constructor(
    public code: 'not-found' | 'backend-mismatch' | 'workspace-not-found',
    message: string,
  ) {
    super(message)
    this.name = 'SessionError'
  }
}

function toView(session: SessionRecord): SessionView {
  const currentBackend = ctx.backendManager.getCurrentId()
  return {
    ...session,
    continuable: session.backend === currentBackend,
    stale: false,
  }
}

export const listSessions = async (args: { workspaceId: string }): Promise<SessionView[]> => {
  const records = ctx.db.listSessions(args.workspaceId)
  return records.map(toView)
}

export const createSession = async (args: CreateSessionArgs): Promise<{ sessionId: string }> => {
  // 校验 workspace 存在
  const ws = ctx.db.findWorkspaceById(args.workspaceId)
  if (!ws) {
    throw new SessionError('workspace-not-found', `workspace not found: ${args.workspaceId}`)
  }

  // 选 backend
  const backend = args.backend ?? ctx.backendManager.getCurrentId()

  // 调 backend.startSession 拿到 backendThreadId
  // 注意：exactOptionalPropertyTypes: true 不允许把 undefined 传给 optional 字段
  const startArgs: Parameters<typeof ctx.backendManager.startSession>[0] = { cwd: args.cwd }
  if (args.model !== undefined) startArgs.model = args.model
  if (args.effort !== undefined) startArgs.effort = args.effort
  if (args.permissionMode !== undefined) startArgs.permissionMode = args.permissionMode
  if (args.initialPrompt !== undefined) startArgs.initialPrompt = args.initialPrompt
  const { backendThreadId } = await ctx.backendManager.startSession(startArgs)

  // 写入 db
  const now = Date.now()
  const sessionId = randomUUID()
  ctx.db.insertSession({
    id: sessionId,
    backend,
    backendThreadId,
    workspaceId: args.workspaceId,
    title: args.initialPrompt?.slice(0, 50) ?? null,
    model: args.model ?? null,
    effort: args.effort ?? null,
    permissionMode: args.permissionMode ?? null,
    turnCount: 0,
    createdAt: now,
    lastActiveAt: now,
  })
  log.info('created session', sessionId, 'backend=', backend)

  return { sessionId }
}

export const removeSession = async (args: { sessionId: string }): Promise<void> => {
  const session = ctx.db.findSessionById(args.sessionId)
  if (!session) {
    throw new SessionError('not-found', `session not found: ${args.sessionId}`)
  }

  // 1. 物理删除后端侧数据（claude .jsonl / codex rollout 文件）
  //    拿 workspace 路径作 cwd——claude 按 cwd 分目录存 jsonl
  const ws = ctx.db.findWorkspaceById(session.workspaceId)
  await ctx.backendManager.deleteSession(session.backend, session.backendThreadId, ws?.path)

  // 2. 写 tombstone——即便物理删除失败（权限/路径错误），reconcile/扫描导入也会跳过
  ctx.db.insertDeletedSession(session.backend, session.backendThreadId)

  // 3. 删 DB 索引
  ctx.db.deleteSession(args.sessionId)
  log.info('removed session', args.sessionId, `(${session.backend}/${session.backendThreadId})`)
}

export const reconcileSessions = async (args: { workspaceId: string }) => {
  const workspace = ctx.db.findWorkspaceById(args.workspaceId)
  if (!workspace) {
    throw new SessionError('workspace-not-found', `workspace not found: ${args.workspaceId}`)
  }
  // 拉后端当前真实列表
  // 容错：如果后端无法拉取（未安装 / 初始化超时 / 协议错误），不阻塞 UI——
  // 把已有 App db 里的会话全部标记为 stale 即可，用户手动 retry 时再同步。
  // 之前的 Bug：codex 未安装时 reconcile 会卡 30s initialize 超时然后抛错，
  // 导致用户切到 claude 后发消息直接无响应。
  let backendSessions: Awaited<ReturnType<typeof ctx.backendManager.listSessions>> = []
  try {
    backendSessions = await ctx.backendManager.listSessions(workspace.path)
  } catch (e) {
    log.warn('listSessions failed during reconcile, skipping backend sync:', e)
  }
  const backendThreadIds = new Set(backendSessions.map((s) => s.backendThreadId))

  // App db 里的
  const appSessions = ctx.db.listSessions(args.workspaceId)

  // 找出后端有、App 没有的（需要登记）
  const added: SessionView[] = []
  for (const bs of backendSessions) {
    const exists = appSessions.find((s) => s.backendThreadId === bs.backendThreadId)
    if (exists) continue
    // tombstone 跳过——用户删过这条，磁盘文件可能还在（物理删除失败/不可达），
    // 但不允许复活。reconcile 是自动同步，必须尊重用户的删除意图。
    if (ctx.db.isSessionDeleted(ctx.backendManager.getCurrentId(), bs.backendThreadId)) {
      continue
    }
    const now = Date.now()
    const sessionId = randomUUID()
    ctx.db.insertSession({
      id: sessionId,
      backend: ctx.backendManager.getCurrentId(),
      backendThreadId: bs.backendThreadId,
      workspaceId: args.workspaceId,
      title: bs.title,
      model: bs.model,
      effort: null,
      permissionMode: null,
      turnCount: 0,
      createdAt: now,
      lastActiveAt: bs.lastActiveAt,
    })
    const inserted = ctx.db.findSessionById(sessionId)
    if (inserted) added.push(toView(inserted))
  }

  // 找出 App 有、后端没有的（标记 stale，不删）
  const removed: string[] = []
  for (const app of appSessions) {
    if (!backendThreadIds.has(app.backendThreadId)) {
      ctx.db.markSessionStale(app.id)
      removed.push(app.id)
    }
  }

  log.info('reconciled', { added: added.length, removed: removed.length })
  return { added, removed }
}

/**
 * 扫描所有 backend 在磁盘/RPC 上存在、但 catmax db 还未登记的会话。
 *
 * - claude：扫所有 ~/.claude/projects/* 目录下的 .jsonl 文件
 * - codex：调 thread/list（不传 cwd，拿全部 thread）
 *
 * 返回每条会话 + 标记：
 * - alreadyImported：是否已在 db（任意 workspace）
 * - matchedWorkspaceId（claude only）：反推 cwd 精确匹配到的 workspace，没有则 undefined
 *
 * 单 backend 失败容错——记录到 errors 数组，不影响其他 backend 的扫描结果。
 */
export const scanImportableSessions = async (): Promise<ScanImportableResult> => {
  const { byBackend, errors } = await ctx.backendManager.listAllSessionsAcrossBackends()

  const workspaces = ctx.db.listWorkspaces()
  // encoded(path) → workspaceId，用于 claude 反推 cwd 的精确正向匹配
  const encodedToWorkspace = new Map<string, string>()
  for (const ws of workspaces) {
    encodedToWorkspace.set(encodeCwdToProjectDir(ws.path), ws.id)
  }

  // 列出 db 里所有已登记 session——用 (backend, backendThreadId) 做 key 查重
  const allDbSessions: Array<{ backend: BackendId; backendThreadId: string; workspaceId: string }> =
    []
  for (const ws of workspaces) {
    for (const s of ctx.db.listSessions(ws.id)) {
      allDbSessions.push({
        backend: s.backend,
        backendThreadId: s.backendThreadId,
        workspaceId: ws.id,
      })
    }
  }
  const dbKeyToWorkspace = new Map<string, string>()
  for (const s of allDbSessions) {
    dbKeyToWorkspace.set(`${s.backend}:${s.backendThreadId}`, s.workspaceId)
  }

  const sessions: ImportableSession[] = []
  let unmatchedCount = 0

  for (const [backendId, summaryList] of Object.entries(byBackend) as Array<
    [BackendId, SessionSummary[]]
  >) {
    for (const s of summaryList) {
      if (!s.backendThreadId) continue // 跳过无效条目
      const dbKey = `${backendId}:${s.backendThreadId}`
      const existingWorkspaceId = dbKeyToWorkspace.get(dbKey)
      const alreadyImported = existingWorkspaceId !== undefined

      // claude 才有 cwd——正向编码匹配
      let matchedWorkspaceId: string | undefined
      if (s.cwd) {
        const encoded = encodeCwdToProjectDir(s.cwd)
        matchedWorkspaceId = encodedToWorkspace.get(encoded)
        if (!matchedWorkspaceId && !alreadyImported) {
          unmatchedCount++
        }
      }

      // exactOptionalPropertyTypes: true 不允许把 undefined 传给 optional 字段，
      // 所以条件赋值——只有 cwd/sizeBytes 等有值时才写到对象上。
      const item: ImportableSession = {
        backend: backendId,
        backendThreadId: s.backendThreadId,
        title: s.title,
        lastActiveAt: s.lastActiveAt,
        model: s.model,
        alreadyImported,
      }
      if (s.cwd !== undefined) item.cwd = s.cwd
      if (s.sizeBytes !== undefined) item.sizeBytes = s.sizeBytes
      if (existingWorkspaceId !== undefined) item.existingWorkspaceId = existingWorkspaceId
      if (matchedWorkspaceId !== undefined) item.matchedWorkspaceId = matchedWorkspaceId
      sessions.push(item)
    }
  }

  // 按最后活跃时间倒序——最近的在前
  sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt)

  log.info('scanImportable', {
    total: sessions.length,
    alreadyImported: sessions.filter((s) => s.alreadyImported).length,
    unmatched: unmatchedCount,
    errors: errors.length,
  })

  return { sessions, unmatchedCount, errors }
}

/**
 * 把外部会话登记到 catmax db，纳入指定 workspace。
 *
 * - 重复导入容错：如果 (backend, backendThreadId) 已存在，跳过
 * - 拉一次 getHistory 拿 aiTitle——claude 在 jsonl 头部写了 ai-title 行，能拿到；
 *   拉失败容错：title 用 backendThreadId 前 8 字符作 fallback，仍登记
 * - backend 字段用会话自己的 backend（不是 currentBackend）
 *
 * 注意：导入后用户点开会话时 getSessionDetail 会再调 getHistory，
 * 这里拉一次只是为了拿到标题——title 拿到后立即回写 db。
 */
export const importSessions = async (args: ImportSessionArgs): Promise<ImportSessionsResult> => {
  const workspaces = ctx.db.listWorkspaces()
  const workspaceById = new Map<string, WorkspaceRecord>()
  for (const ws of workspaces) workspaceById.set(ws.id, ws)

  const imported: SessionView[] = []
  const skipped: Array<{ backendThreadId: string; reason: string }> = []

  for (const item of args.sessions) {
    // tombstone 跳过——用户删过的不让导入回来
    if (ctx.db.isSessionDeleted(item.backend, item.backendThreadId)) {
      skipped.push({
        backendThreadId: item.backendThreadId,
        reason: 'user deleted this session',
      })
      continue
    }
    const ws = workspaceById.get(item.workspaceId)
    if (!ws) {
      skipped.push({
        backendThreadId: item.backendThreadId,
        reason: `workspace not found: ${item.workspaceId}`,
      })
      continue
    }

    // 重复检查——db 里已存在 (backend, backendThreadId) 就跳过
    const existing = ctx.db.findSessionByBackendThreadId(item.backend, item.backendThreadId)
    if (existing) {
      skipped.push({
        backendThreadId: item.backendThreadId,
        reason: `already imported (session ${existing.id})`,
      })
      continue
    }

    // 拉历史拿 aiTitle——claude 用 ws.path 作 cwd 读 jsonl；codex 不需要 cwd
    let title: string | null = null
    try {
      const { aiTitle } = await ctx.backendManager.getHistory(
        item.backend,
        item.backendThreadId,
        ws.path,
      )
      title = aiTitle ?? null
    } catch (e) {
      log.warn(
        `importSessions: getHistory failed for ${item.backend}:${item.backendThreadId}, using fallback title:`,
        e,
      )
    }
    // fallback：title 为 null 时用 backendThreadId 前 8 字符
    if (!title) {
      title = item.backendThreadId.slice(0, 8)
    }

    const now = Date.now()
    const sessionId = randomUUID()
    ctx.db.insertSession({
      id: sessionId,
      backend: item.backend,
      backendThreadId: item.backendThreadId,
      workspaceId: item.workspaceId,
      title,
      model: null,
      effort: null,
      permissionMode: null,
      turnCount: 0,
      // 没拿到磁盘记录的创建时间，用 lastActiveAt 代替；如果 summary 里有更精确的可以补
      createdAt: now,
      lastActiveAt: now,
    })
    const inserted = ctx.db.findSessionById(sessionId)
    if (inserted) {
      imported.push(toView(inserted))
      log.info('imported session', sessionId, `(${item.backend})`)
    }
  }

  log.info('importSessions done', { imported: imported.length, skipped: skipped.length })
  return { imported, skipped }
}

export const getSessionDetail = async (args: { sessionId: string }) => {
  const session = ctx.db.findSessionById(args.sessionId)
  if (!session) {
    throw new SessionError('not-found', `session not found: ${args.sessionId}`)
  }
  // 用会话自己的后端拉历史（不是当前后端）——这样切换后端后仍能回看旧会话。
  // cwd 必须传——claude 把历史文件按 cwd 分目录存，不传 claude 会用 main 进程的
  // cwd（catmax-app 自己根目录），导致 "No conversation found" 错误，UI 看到空历史。
  const workspace = ctx.db.findWorkspaceById(session.workspaceId)
  const cwd = workspace?.path
  const { messages, aiTitle } = await ctx.backendManager.getHistory(
    session.backend,
    session.backendThreadId,
    cwd,
  )

  // 后端返回了 aiTitle（claude 自动生成的会话标题）且 db 里 title 为空/不一致时，
  // 把它回写到 db + 用回写后的 session 视图返回。这样侧边栏会话标题会刷新。
  let updatedSession = session
  if (aiTitle && aiTitle !== session.title) {
    ctx.db.updateSessionTitle(session.id, aiTitle)
    log.info('updated session title from backend', session.id, aiTitle)
    updatedSession = ctx.db.findSessionById(session.id) ?? session
  }

  return {
    session: toView(updatedSession),
    messages,
    aiTitle,
  }
}
