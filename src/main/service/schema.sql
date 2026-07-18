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
