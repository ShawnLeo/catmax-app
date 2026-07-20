import { randomUUID } from 'node:crypto'

import { ctx } from '@main/context'
import { logger } from '@main/service/logger'
import type { SessionRecord, SessionView } from '@shared/domain'
import type { CreateSessionArgs } from '@shared/ipc/session'

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
  // 删 App 索引（codex 那边的 rollout 文件不动——用户可能想保留）
  ctx.db.deleteSession(args.sessionId)
  log.info('removed session', args.sessionId)
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
    if (!exists) {
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
