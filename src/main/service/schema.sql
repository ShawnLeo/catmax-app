-- catmax-app SQLite schema
-- Plan 1 仅创建 workspaces 和 app_state；其他表在后续 plan 添加

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
  id              TEXT PRIMARY KEY,
  path            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  preferred_editor TEXT,
  last_opened_at  INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_workspaces_last_opened ON workspaces(last_opened_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  backend           TEXT NOT NULL,
  backend_thread_id TEXT NOT NULL,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title             TEXT,
  model             TEXT,
  effort            TEXT,
  permission_mode   TEXT,
  turn_count        INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  last_active_at    INTEGER NOT NULL,
  UNIQUE(backend, backend_thread_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id, last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_backend ON sessions(workspace_id, backend);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id         TEXT NOT NULL,
  role            TEXT NOT NULL,
  text_preview    TEXT NOT NULL,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
