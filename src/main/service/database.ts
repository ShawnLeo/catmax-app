import { join } from 'node:path'

import type { BackendId } from '@shared/constants'
import type {
  MessagePreview,
  SessionRecord,
  TurnRunRecord,
  TurnRunStatus,
  WorkspaceFolderRecord,
  WorkspaceRecord,
} from '@shared/domain'
import Database from 'better-sqlite3'
import { app } from 'electron'

import { logger } from './logger'
import schemaSql from './schema.sql?raw'

const log = logger.domain('database')

interface WorkspaceRow {
  id: string
  path: string
  name: string
  preferred_editor: string | null
  last_opened_at: number
  created_at: number
}

interface WorkspaceFolderRow {
  id: string
  workspace_id: string
  path: string
  alias: string
  role: string
  sort_order: number
  created_at: number
}

function rowToFolderRecord(row: WorkspaceFolderRow): WorkspaceFolderRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    path: row.path,
    alias: row.alias,
    role: row.role as WorkspaceFolderRecord['role'],
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  }
}

function rowToRecord(row: WorkspaceRow, folders: WorkspaceFolderRecord[]): WorkspaceRecord {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    folders,
    preferredEditor: row.preferred_editor as WorkspaceRecord['preferredEditor'],
    lastOpenedAt: row.last_opened_at,
    createdAt: row.created_at,
  }
}

/**
 * Session Pin: 会话列表统一排序。
 *
 * `pinned_at IS NULL` 在 sqlite 里求值成 0/1，升序即"置顶的（0）排在未置顶的（1）前面"；
 * 置顶组内按置顶时间倒序（最近置顶的在最上），未置顶组内按活跃时间倒序（原有行为）。
 */
const SESSION_ORDER_BY = 'ORDER BY pinned_at IS NULL, pinned_at DESC, last_active_at DESC'

export class DatabaseService {
  private db: Database.Database

  constructor(dbPath?: string) {
    const path = dbPath ?? this.defaultPath()
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    log.info('opened', path)
  }

  private defaultPath(): string {
    // 测试环境或非 Electron 上下文回退到 cwd
    try {
      return join(app.getPath('userData'), 'catmax.db')
    } catch {
      return join(process.cwd(), 'catmax.db')
    }
  }

  migrate(): void {
    // schema 由 Vite 在构建期内联成字符串（见 src/main/env.d.ts）。
    // 不能改回运行时读盘：打包后 out/main/ 只有 index.js，schema.sql 不在 asar 里，
    // 而按 process.cwd() 找源码的兜底只在"从项目根目录启动"时才碰巧成立，
    // 从 Finder/Dock 启动时 cwd 是 /，迁移必然失败且窗口永远不显示。
    this.db.exec(schemaSql)
    this.migrateAddColumns()
    this.migrateWorkspaceFolders()
    log.info('migrated')
  }

  /** 旧版一条 workspace=一个目录；首次升级时把它登记为主文件夹。 */
  private migrateWorkspaceFolders(): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO workspace_folders
           (id, workspace_id, path, alias, role, sort_order, created_at)
         SELECT id || ':primary', id, path, name, 'primary', 0, created_at
         FROM workspaces`,
      )
      .run()
  }

  /**
   * 给已存在的表补列。
   *
   * schema.sql 全是 `CREATE TABLE IF NOT EXISTS`，没有版本号——老库里表已经存在，
   * 重跑 schema 不会把新列加进去，所以每个新增列都要在这里手写一条守卫 ALTER。
   * 判断方式用 PRAGMA table_info 而不是 catch 异常，避免把真正的 SQL 错误吞掉。
   */
  private migrateAddColumns(): void {
    const addColumn = (table: string, column: string, definition: string): void => {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string
      }>
      if (columns.some((c) => c.name === column)) return
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
      log.info(`migrated: added ${table}.${column}`)
    }
    // Session Pin / Session Rename——见 schema.sql 里同名列的注释
    addColumn('sessions', 'pinned_at', 'INTEGER')
    addColumn('sessions', 'title_custom', 'INTEGER NOT NULL DEFAULT 0')
  }

  // ===== Workspace =====

  listWorkspaces(): WorkspaceRecord[] {
    // Stable tiebreaker on hidden `rowid`: last_opened_at has millisecond
    // resolution, so two workspaces touched/added within the same ms would
    // otherwise come back in unspecified order. rowid is unique per row and
    // monotonic by insertion, so DESC means "most recently inserted wins"
    // among ties — matching the intuition that a just-added workspace ranks
    // above an older one touched in the same millisecond.
    const rows = this.db
      .prepare('SELECT * FROM workspaces ORDER BY last_opened_at DESC, rowid DESC')
      .all() as WorkspaceRow[]
    return rows.map((row) => rowToRecord(row, this.listWorkspaceFolders(row.id)))
  }

  findWorkspaceByPath(path: string): WorkspaceRecord | null {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE path = ?').get(path) as
      WorkspaceRow | undefined
    return row ? rowToRecord(row, this.listWorkspaceFolders(row.id)) : null
  }

  findWorkspaceById(id: string): WorkspaceRecord | null {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
      WorkspaceRow | undefined
    return row ? rowToRecord(row, this.listWorkspaceFolders(row.id)) : null
  }

  listWorkspaceFolders(workspaceId: string): WorkspaceFolderRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM workspace_folders WHERE workspace_id = ? ORDER BY sort_order, rowid')
      .all(workspaceId) as WorkspaceFolderRow[]
    return rows.map(rowToFolderRecord)
  }

  findWorkspaceFolderById(folderId: string): WorkspaceFolderRecord | null {
    const row = this.db.prepare('SELECT * FROM workspace_folders WHERE id = ?').get(folderId) as
      WorkspaceFolderRow | undefined
    return row ? rowToFolderRecord(row) : null
  }

  insertWorkspace(record: WorkspaceRecord): WorkspaceRecord {
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO workspaces (id, path, name, preferred_editor, last_opened_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.path,
          record.name,
          record.preferredEditor,
          record.lastOpenedAt,
          record.createdAt,
        )
      const statement = this.db.prepare(
        `INSERT INTO workspace_folders
           (id, workspace_id, path, alias, role, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const folder of record.folders) {
        statement.run(
          folder.id,
          record.id,
          folder.path,
          folder.alias,
          folder.role,
          folder.sortOrder,
          folder.createdAt,
        )
      }
    })
    insert()
    return record
  }

  updateWorkspaceName(id: string, name: string): void {
    this.db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(name, id)
  }

  /**
   * 全量替换某工作区的次文件夹——主文件夹不动（保留 role='primary' 行），
   * 先删掉所有 secondary，再按传入顺序插入新的。整个操作在一个事务里。
   * name 也一并更新（编辑弹窗一次提交）。返回更新后的完整 record。
   */
  updateWorkspaceFolders(
    id: string,
    name: string,
    secondaryFolders: WorkspaceFolderRecord[],
  ): WorkspaceRecord | null {
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(name, id)
      this.db
        .prepare(`DELETE FROM workspace_folders WHERE workspace_id = ? AND role = 'secondary'`)
        .run(id)
      const insert = this.db.prepare(
        `INSERT INTO workspace_folders
           (id, workspace_id, path, alias, role, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const folder of secondaryFolders) {
        insert.run(
          folder.id,
          folder.workspaceId,
          folder.path,
          folder.alias,
          folder.role,
          folder.sortOrder,
          folder.createdAt,
        )
      }
    })
    tx()
    return this.findWorkspaceById(id)
  }

  updateWorkspaceEditor(id: string, editor: string | null): void {
    this.db.prepare('UPDATE workspaces SET preferred_editor = ? WHERE id = ?').run(editor, id)
  }

  touchWorkspace(id: string, timestamp: number): void {
    this.db.prepare('UPDATE workspaces SET last_opened_at = ? WHERE id = ?').run(timestamp, id)
  }

  deleteWorkspace(id: string): void {
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
  }

  // ===== app_state =====

  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as
      { value: string } | undefined
    return row?.value ?? null
  }

  setState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value)
  }

  deleteState(key: string): void {
    this.db.prepare('DELETE FROM app_state WHERE key = ?').run(key)
  }

  // ===== Session =====

  /**
   * 列出工作区的会话。
   *
   * backend 可选——传了则只返回该 backend 的会话（走 idx_sessions_backend 索引），
   * 不传则返回所有 backend 的会话（走 idx_sessions_workspace 索引，用于 reconcile /
   * scanImportable 等需要全量对账的场景）。
   *
   * Session Pin: 排序统一走 SESSION_ORDER_BY——置顶的整体排在前面，组内各自按时间倒序。
   */
  listSessions(workspaceId: string, backend?: BackendId): SessionRecord[] {
    if (backend) {
      const rows = this.db
        .prepare(
          `SELECT * FROM sessions WHERE workspace_id = ? AND backend = ? ${SESSION_ORDER_BY}`,
        )
        .all(workspaceId, backend) as SessionRow[]
      return rows.map(rowToSessionRecord)
    }
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE workspace_id = ? ${SESSION_ORDER_BY}`)
      .all(workspaceId) as SessionRow[]
    return rows.map(rowToSessionRecord)
  }

  findSessionById(id: string): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      SessionRow | undefined
    return row ? rowToSessionRecord(row) : null
  }

  findSessionByBackendThreadId(backend: string, backendThreadId: string): SessionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE backend = ? AND backend_thread_id = ?')
      .get(backend, backendThreadId) as SessionRow | undefined
    return row ? rowToSessionRecord(row) : null
  }

  insertSession(record: SessionRecord): SessionRecord {
    this.db
      .prepare(
        `INSERT INTO sessions (id, backend, backend_thread_id, workspace_id, title, model, effort, permission_mode, turn_count, created_at, last_active_at, pinned_at, title_custom)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.backend,
        record.backendThreadId,
        record.workspaceId,
        record.title,
        record.model,
        record.effort,
        record.permissionMode,
        record.turnCount,
        record.createdAt,
        record.lastActiveAt,
        record.pinnedAt,
        record.titleCustom ? 1 : 0,
      )
    return record
  }

  /**
   * 后端自动标题（claude aiTitle）回写。
   *
   * Session Rename: 带 `title_custom = 0` 条件——用户手动重命名过的会话不再被
   * AI 标题覆盖。用户重命名后下一个 turn 结束时 refreshClaudeSessionTitle 会再次
   * 尝试回写，没有这个条件用户的改名就白改了。
   */
  updateSessionTitle(id: string, title: string): void {
    this.db
      .prepare('UPDATE sessions SET title = ? WHERE id = ? AND title_custom = 0')
      .run(title, id)
  }

  /**
   * Session Rename: 用户手动重命名——直接覆盖并把 title_custom 置 1。
   * 与 updateSessionTitle 的区别就是"谁说了算"：这个无条件生效，且锁死后端自动标题。
   */
  renameSession(id: string, title: string): void {
    this.db.prepare('UPDATE sessions SET title = ?, title_custom = 1 WHERE id = ?').run(title, id)
  }

  /** Session Pin: 置顶/取消置顶。pinned=true 时写当前时间戳，false 时写 NULL。 */
  setSessionPinned(id: string, pinned: boolean): void {
    this.db
      .prepare('UPDATE sessions SET pinned_at = ? WHERE id = ?')
      .run(pinned ? Date.now() : null, id)
  }

  /**
   * 更新 session 的运行时配置（model / effort / permission_mode）。
   *
   * 与 bumpSessionTurn 的区别：
   *   - bumpSessionTurn 用 COALESCE（仅非 null 才覆盖），用于"turn 结束补全字段"。
   *   - updateSessionConfig 直接覆盖，用户在 Composer 里改了配置后立即写回。
   *
   * backend 不在这里写——session.backend 是会话固有属性（创建时定），
   * 切 backend 走全局 currentBackend 切换 + 新建会话时再用。
   *
   * 全部参数可选——只更新传入的字段（用 COALESCE 跳过 undefined）。
   */
  updateSessionConfig(
    id: string,
    config: {
      model?: string | null | undefined
      effort?: string | null | undefined
      permissionMode?: string | null | undefined
    },
  ): void {
    this.db
      .prepare(
        `UPDATE sessions
         SET model = COALESCE(?, model),
             effort = COALESCE(?, effort),
             permission_mode = COALESCE(?, permission_mode)
         WHERE id = ?`,
      )
      .run(config.model ?? null, config.effort ?? null, config.permissionMode ?? null, id)
  }

  /**
   * 更新 session 的 backend_thread_id（claude 用：拿到真实 session_id 后回写）。
   * byBackendThreadId 是当前的占位 id，用 (backend, backend_thread_id) 唯一约束定位行。
   */
  updateSessionBackendThreadId(
    backend: string,
    oldBackendThreadId: string,
    newBackendThreadId: string,
  ): void {
    this.db
      .prepare(
        `UPDATE sessions SET backend_thread_id = ? WHERE backend = ? AND backend_thread_id = ?`,
      )
      .run(newBackendThreadId, backend, oldBackendThreadId)
  }

  bumpSessionTurn(
    id: string,
    lastActiveAt: number,
    model?: string,
    effort?: string,
    permissionMode?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE sessions
         SET turn_count = turn_count + 1,
             last_active_at = ?,
             model = COALESCE(?, model),
             effort = COALESCE(?, effort),
             permission_mode = COALESCE(?, permission_mode)
         WHERE id = ?`,
      )
      .run(lastActiveAt, model ?? null, effort ?? null, permissionMode ?? null, id)
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  /** 标记 stale（后端已删除但 App 还有索引）—— MVP 不真删，留着让用户决定 */
  markSessionStale(_id: string): void {
    // 暂时不实现，留给 Plan 3+
  }

  /**
   * 记录 tombstone——removeSession 时调用。
   * 即便物理删除后端文件失败（权限/路径错误），写入 tombstone 也能让
   * reconcileSessions / importSessions 跳过这条，防止会话"复活"。
   */
  insertDeletedSession(backend: BackendId, backendThreadId: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO deleted_sessions (backend, backend_thread_id, deleted_at) VALUES (?, ?, ?)`,
      )
      .run(backend, backendThreadId, Date.now())
  }

  /** 查 (backend, backendThreadId) 是否被用户删除过——reconcile/import 用 */
  isSessionDeleted(backend: BackendId, backendThreadId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM deleted_sessions WHERE backend = ? AND backend_thread_id = ?')
      .get(backend, backendThreadId)
    return row !== undefined
  }

  // ===== Message =====

  listMessages(sessionId: string): MessagePreview[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at')
      .all(sessionId) as MessageRow[]
    return rows.map(rowToMessagePreview)
  }

  insertMessage(record: MessagePreview): MessagePreview {
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, turn_id, role, text_preview, tool_call_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.turnId,
        record.role,
        record.textPreview,
        record.toolCallCount,
        record.createdAt,
      )
    return record
  }

  // ===== Turn Run =====

  upsertTurnRun(record: TurnRunRecord): void {
    this.db
      .prepare(
        `INSERT INTO turn_runs (
           id, session_id, backend, backend_turn_id, status, background_tasks_json,
           created_at, started_at, last_event_at, completed_at, error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           backend_turn_id = excluded.backend_turn_id,
           status = excluded.status,
           background_tasks_json = excluded.background_tasks_json,
           started_at = excluded.started_at,
           last_event_at = excluded.last_event_at,
           completed_at = excluded.completed_at,
           error = excluded.error`,
      )
      .run(
        record.id,
        record.sessionId,
        record.backend,
        record.backendTurnId,
        record.status,
        JSON.stringify(record.backgroundTasks),
        record.createdAt,
        record.startedAt,
        record.lastEventAt,
        record.completedAt,
        record.error,
      )
  }

  listTurnRuns(sessionId?: string): TurnRunRecord[] {
    const rows = (
      sessionId
        ? this.db
            .prepare('SELECT * FROM turn_runs WHERE session_id = ? ORDER BY created_at DESC')
            .all(sessionId)
        : this.db.prepare('SELECT * FROM turn_runs ORDER BY created_at DESC').all()
    ) as TurnRunRow[]
    return rows.map(rowToTurnRunRecord)
  }

  listRecoverableTurnRuns(): TurnRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM turn_runs
         WHERE status IN ('queued', 'running', 'cancelling')
         ORDER BY created_at`,
      )
      .all() as TurnRunRow[]
    return rows.map(rowToTurnRunRecord)
  }

  deleteTurnRunsCompletedBefore(timestamp: number): number {
    return this.db
      .prepare(
        `DELETE FROM turn_runs
         WHERE completed_at IS NOT NULL
           AND completed_at < ?
           AND status IN ('completed', 'interrupted', 'error')`,
      )
      .run(timestamp).changes
  }

  close(): void {
    this.db.close()
    log.info('closed')
  }
}

export type Database = DatabaseService

interface SessionRow {
  id: string
  backend: string
  backend_thread_id: string
  workspace_id: string
  title: string | null
  model: string | null
  effort: string | null
  permission_mode: string | null
  turn_count: number
  created_at: number
  last_active_at: number
  pinned_at: number | null
  title_custom: number
}

interface MessageRow {
  id: string
  session_id: string
  turn_id: string
  role: string
  text_preview: string
  tool_call_count: number
  created_at: number
}

interface TurnRunRow {
  id: string
  session_id: string
  backend: string
  backend_turn_id: string | null
  status: string
  background_tasks_json: string
  created_at: number
  started_at: number | null
  last_event_at: number | null
  completed_at: number | null
  error: string | null
}

function rowToSessionRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    backend: row.backend as SessionRecord['backend'],
    backendThreadId: row.backend_thread_id,
    workspaceId: row.workspace_id,
    title: row.title,
    model: row.model,
    effort: row.effort as SessionRecord['effort'],
    permissionMode: row.permission_mode as SessionRecord['permissionMode'],
    turnCount: row.turn_count,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    pinnedAt: row.pinned_at,
    // 老库补列前写入的行读出来是 0，`?? 0` 只是防御 PRAGMA 之外的意外 null
    titleCustom: (row.title_custom ?? 0) === 1,
  }
}

function rowToMessagePreview(row: MessageRow): MessagePreview {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    role: row.role as MessagePreview['role'],
    textPreview: row.text_preview,
    toolCallCount: row.tool_call_count,
    createdAt: row.created_at,
  }
}

function rowToTurnRunRecord(row: TurnRunRow): TurnRunRecord {
  let backgroundTasks: TurnRunRecord['backgroundTasks'] = []
  try {
    const parsed: unknown = JSON.parse(row.background_tasks_json)
    if (Array.isArray(parsed)) {
      backgroundTasks = parsed as TurnRunRecord['backgroundTasks']
    }
  } catch {
    // 损坏的诊断快照不应阻止应用启动；协调器会从空集合继续。
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    backend: row.backend as TurnRunRecord['backend'],
    backendTurnId: row.backend_turn_id,
    status: row.status as TurnRunStatus,
    backgroundTasks,
    createdAt: row.created_at,
    startedAt: row.started_at,
    lastEventAt: row.last_event_at,
    completedAt: row.completed_at,
    error: row.error,
  }
}
