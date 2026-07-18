import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { WorkspaceRecord } from '@shared/domain'
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

  close(): void {
    this.db.close()
    log.info('closed')
  }
}

export type Database = DatabaseService
