import { randomUUID } from 'node:crypto'

import { readSubagentHistory as readSubagentHistoryFromJsonl } from '@main/backend/claude/jsonl-reader'
import { encodeCwdToProjectDir } from '@main/backend/claude/jsonl-reader'
import { ctx } from '@main/context'
import { logger } from '@main/service/logger'
import type { SessionSummary, NormalizedMessage } from '@shared/backend/types'
import { STORAGE_KEYS, type BackendId } from '@shared/constants'
import type { SessionRecord, SessionView, WorkspaceRecord } from '@shared/domain'
import type {
  CreateSessionArgs,
  ImportSessionArgs,
  ImportSessionsResult,
  ImportableSession,
  RuntimeConfigSnapshot,
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

export const listSessions = async (args: {
  workspaceId: string
  backend: BackendId
}): Promise<SessionView[]> => {
  // 按当前后端过滤——列表只展示当前 backend 的会话，避免 claude / codex 混排。
  // 过滤在 DB 层做（走 idx_sessions_backend 索引），不是 .filter()，避免拉全量再筛。
  const records = ctx.db.listSessions(args.workspaceId, args.backend)
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

  // 软删除：只删 catmax 的 db 记录 + 写 tombstone，不碰后端磁盘文件。
  //
  // 历史问题：旧实现会调 backendManager.deleteSession 物理删除 claude .jsonl / codex
  // rollout 文件，导致用户以为是"移除记录"，实际把原始会话历史永久销毁，删错后无法
  // 重新扫描导入。改为软删除后：
  //   - reconcile 仍查 tombstone → 软删的会话不会被自动同步复活（尊重用户删除意图）
  //   - scanImportable / importSessions 不查 tombstone → 用户可主动重新导入（可恢复）
  // 若用户想彻底清除磁盘文件，去 claude/codex 原生工具删除即可。

  // 1. 写 tombstone——reconcile 自动同步时据此跳过，防止软删的会话被自动加回来
  ctx.db.insertDeletedSession(session.backend, session.backendThreadId)

  // 2. 删 DB 索引
  ctx.db.deleteSession(args.sessionId)
  log.info(
    'removed session (soft)',
    args.sessionId,
    `(${session.backend}/${session.backendThreadId})`,
  )
}

export const reconcileSessions = async (args: { workspaceId: string }) => {
  const workspace = ctx.db.findWorkspaceById(args.workspaceId)
  if (!workspace) {
    throw new SessionError('workspace-not-found', `workspace not found: ${args.workspaceId}`)
  }
  // 只对当前 backend 做对账——会话列表已按当前 backend 过滤，
  // reconcile 的语义是"当前 backend 的 db 记录 ↔ 当前 backend 的磁盘真实状态"。
  const currentBackend = ctx.backendManager.getCurrentId()

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

  // App db 里的——必须过滤成当前 backend，否则会把别的 backend 的会话误标 stale
  // （它们的 backendThreadId 不在当前 backend 的真实列表里）。
  const appSessions = ctx.db.listSessions(args.workspaceId, currentBackend)

  // 找出后端有、App 没有的（需要登记）
  const added: SessionView[] = []
  for (const bs of backendSessions) {
    const exists = appSessions.find((s) => s.backendThreadId === bs.backendThreadId)
    if (exists) continue
    // tombstone 跳过——用户删过这条，磁盘文件可能还在（物理删除失败/不可达），
    // 但不允许复活。reconcile 是自动同步，必须尊重用户的删除意图。
    if (ctx.db.isSessionDeleted(currentBackend, bs.backendThreadId)) {
      continue
    }
    const now = Date.now()
    const sessionId = randomUUID()
    ctx.db.insertSession({
      id: sessionId,
      backend: currentBackend,
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
 * 扫描当前后端在磁盘/RPC 上存在、但 catmax db 还未登记的会话（只扫当前 backend）。
 *
 * - claude：扫 ~/.claude/projects/* 目录下的 .jsonl 文件（由当前 backend 的 adapter 决定）
 * - codex：调 thread/list（不传 cwd，拿全部 thread）
 *
 * 返回每条会话 + 标记：
 * - alreadyImported：是否已在 db（任意 workspace）
 * - matchedWorkspaceId（claude only）：反推 cwd 精确匹配到的 workspace，没有则 undefined
 *
 * 单后端扫描失败时记录到 errors 数组（运行时最多 1 条），不抛错，让 dialog 降级展示。
 */
export const scanImportableSessions = async (): Promise<ScanImportableResult> => {
  const currentBackend = ctx.backendManager.getCurrentId()

  // 只扫当前 backend——不再跨 backend 扫描。失败容错到 errors，不抛。
  let summaryList: SessionSummary[] = []
  const errors: ScanImportableResult['errors'] = []
  try {
    summaryList = await ctx.backendManager.listSessions()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    errors.push({ backend: currentBackend, error: message })
    log.warn(`listSessions failed for ${currentBackend}:`, message)
  }

  const workspaces = ctx.db.listWorkspaces()
  // encoded(path) → workspaceId，用于 claude 反推 cwd 的精确正向匹配
  const encodedToWorkspace = new Map<string, string>()
  for (const ws of workspaces) {
    encodedToWorkspace.set(encodeCwdToProjectDir(ws.path), ws.id)
  }

  // 列出 db 里当前 backend 的已登记 session——用 backendThreadId 做 key 查重
  // （只查同 backend 才会撞 key，跨 backend 不会冲突，所以只扫当前 backend 即可）
  const dbThreadToWorkspace = new Map<string, string>()
  for (const ws of workspaces) {
    for (const s of ctx.db.listSessions(ws.id, currentBackend)) {
      dbThreadToWorkspace.set(s.backendThreadId, ws.id)
    }
  }

  const sessions: ImportableSession[] = []
  let unmatchedCount = 0

  for (const s of summaryList) {
    if (!s.backendThreadId) continue // 跳过无效条目
    const existingWorkspaceId = dbThreadToWorkspace.get(s.backendThreadId)
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
      backend: currentBackend,
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
    // 注意：导入（用户主动行为）不检查 tombstone——只检查重复登记。
    // tombstone 仅用于 reconcile（自动同步）防止物理删除失败的会话复活；
    // 用户手动删除后又主动扫描导入同一条，是明确意图，应允许。
    // （scanImportable 不查 tombstone，dialog 能看到；这里也不能挡，否则用户删后无法重导）
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

    // 标题优先级：扫描时拿到的 title > claude jsonl 里的 aiTitle > backendThreadId 前 8 字符。
    //
    // 历史问题：之前只依赖 getHistory 的 aiTitle，但 codex 的 getHistory 不返回 aiTitle
    // （那是 claude jsonl 头部特有的），导致 codex 会话全部 fallback 成 UUID 前缀。
    // 现在 scanImportable 已经从 codex thread.name/preview 拿到了正确标题，直接用即可。
    let title: string | null = item.title ?? null
    // claude 若扫描没拿到 title，再尝试 getHistory 读 aiTitle（jsonl 头部可能有更精确的标题）
    if (!title && item.backend === 'claude') {
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
    }
    // 最终 fallback：title 仍为 null 时用 backendThreadId 前 8 字符
    if (!title) {
      title = item.backendThreadId.slice(0, 8)
    }

    // lastActiveAt 优先用扫描值（更准确），没有才用当前时间
    const lastActiveAt = item.lastActiveAt ?? Date.now()
    const sessionId = randomUUID()
    ctx.db.insertSession({
      id: sessionId,
      backend: item.backend,
      backendThreadId: item.backendThreadId,
      workspaceId: item.workspaceId,
      title,
      model: item.model ?? null,
      effort: null,
      permissionMode: null,
      turnCount: 0,
      // 没拿到磁盘记录的创建时间，用 lastActiveAt 代替
      createdAt: lastActiveAt,
      lastActiveAt,
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

/**
 * 读取子 Agent（Task 工具调用）的完整会话历史。
 *
 * 用于 TaskCard 完成后展开按钮点击，把子 Agent 的每一步（Read/Edit/Bash/文本）
 * 嵌入为可折叠的子会话视图。
 */
export const readSubagentHistory = async (args: {
  backend: BackendId
  agentId: string
  cwd: string
}): Promise<NormalizedMessage[]> => {
  // 只有 claude 有子 agent（codex 返回空数组）
  if (args.backend !== 'claude') return []
  return readSubagentHistoryFromJsonl(args.agentId, args.cwd)
}

/**
 * 写回 session 的运行时配置（model / effort / permissionMode）。
 *
 * 用户在 Composer 改配置时调（不只更新 last-used 缓存，也写回当前 session）——
 * 这样切到别的会话再切回来，能恢复到用户最后一次在这个会话里用的配置。
 *
 * session.backend 不写——是会话固有属性（创建时定）。
 */
export const updateSessionConfig = async (args: {
  sessionId: string
  model?: string | null
  effort?: string | null
  permissionMode?: string | null
}): Promise<void> => {
  const session = ctx.db.findSessionById(args.sessionId)
  if (!session) {
    throw new SessionError('not-found', `session not found: ${args.sessionId}`)
  }
  ctx.db.updateSessionConfig(args.sessionId, {
    model: args.model,
    effort: args.effort,
    permissionMode: args.permissionMode,
  })
}

/**
 * 读"最近一次运行时配置"快照（给新建会话用做默认值）。
 *
 * 存在 app_state 表里（key=LAST_RUNTIME_CONFIG），值是 RuntimeConfigSnapshot JSON。
 * 文件未初始化 / JSON 损坏时返回 null——调用方兜底成默认值。
 */
export const getLastRuntimeConfig = async (): Promise<RuntimeConfigSnapshot | null> => {
  const raw = ctx.db.getState(STORAGE_KEYS.LAST_RUNTIME_CONFIG)
  if (!raw) return null
  try {
    return JSON.parse(raw) as RuntimeConfigSnapshot
  } catch (e) {
    log.warn('failed to parse last runtime config, ignoring:', e)
    return null
  }
}

/** 覆盖写最近一次运行时配置快照。 */
export const setLastRuntimeConfig = async (args: RuntimeConfigSnapshot): Promise<void> => {
  ctx.db.setState(STORAGE_KEYS.LAST_RUNTIME_CONFIG, JSON.stringify(args))
}
