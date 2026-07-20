import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { MessagePreview, SessionRecord, WorkspaceRecord } from '@shared/domain'
import Database from 'better-sqlite3'
import { app } from 'electron'

import { logger } from './logger'

const log = logger.domain('database')

const __dirname = dirname(fileURLToPath(import.meta.url))

interface WorkspaceRow {
  id: string
  path: string
  name: string
  preferred_editor: string | null
  last_opened_at: number
  created_at: number
}

function rowToRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    preferredEditor: row.preferred_editor as WorkspaceRecord['preferredEditor'],
    lastOpenedAt: row.last_opened_at,
    createdAt: row.created_at,
  }
}

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
    // 在测试环境，schema.sql 路径解析不同。允许传入 SQL 字符串。
    let schema: string
    try {
      schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8')
    } catch {
      // dev 模式 fallback：从源码读
      schema = readFileSync(join(process.cwd(), 'src/main/service/schema.sql'), 'utf-8')
    }
    this.db.exec(schema)
    log.info('migrated')
  }

  // ===== Workspace =====

  listWorkspaces(): WorkspaceRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM workspaces ORDER BY last_opened_at DESC')
      .all() as WorkspaceRow[]
    return rows.map(rowToRecord)
  }

  findWorkspaceByPath(path: string): WorkspaceRecord | null {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE path = ?').get(path) as
      WorkspaceRow | undefined
    return row ? rowToRecord(row) : null
  }

  findWorkspaceById(id: string): WorkspaceRecord | null {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
      WorkspaceRow | undefined
    return row ? rowToRecord(row) : null
  }

  insertWorkspace(record: WorkspaceRecord): WorkspaceRecord {
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
    return record
  }

  updateWorkspaceName(id: string, name: string): void {
    this.db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(name, id)
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

  listSessions(workspaceId: string): SessionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE workspace_id = ? ORDER BY last_active_at DESC')
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
        `INSERT INTO sessions (id, backend, backend_thread_id, workspace_id, title, model, effort, permission_mode, turn_count, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      )
    return record
  }

  updateSessionTitle(id: string, title: string): void {
    this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id)
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
