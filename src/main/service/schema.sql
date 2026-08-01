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
  -- Session Pin: 置顶时间戳（NULL = 未置顶）。存时间戳而非布尔，
  -- 多条置顶会话之间按"最近置顶的在最上面"排序。
  pinned_at         INTEGER,
  -- Session Rename: 用户手动改过标题。置 1 后 claude 的 aiTitle 不再回写覆盖，
  -- 否则用户重命名完，下一个 turn 结束就被 AI 自动标题冲掉。
  title_custom      INTEGER NOT NULL DEFAULT 0,
  UNIQUE(backend, backend_thread_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id, last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_backend ON sessions(workspace_id, backend);

-- 用户删除过的 (backend, backendThreadId) 记录——tombstone。
-- removeSession 时写入；reconcile/扫描导入查询跳过，防止磁盘文件还在导致"复活"。
-- 物理删除（删 claude jsonl / codex rollout 文件）失败时也兜底。
CREATE TABLE IF NOT EXISTS deleted_sessions (
  backend           TEXT NOT NULL,
  backend_thread_id TEXT NOT NULL,
  deleted_at        INTEGER NOT NULL,
  PRIMARY KEY (backend, backend_thread_id)
);

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

-- per-turn 后台任务协调器的可恢复快照。
-- 本地 Agent 子进程不能跨 App 重启重连；启动恢复时把非终态记录推进 interrupted，
-- 但保留 background_tasks_json 供 UI/诊断读取。
CREATE TABLE IF NOT EXISTS turn_runs (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL,
  backend               TEXT NOT NULL,
  backend_turn_id       TEXT,
  status                TEXT NOT NULL,
  background_tasks_json TEXT NOT NULL DEFAULT '[]',
  created_at            INTEGER NOT NULL,
  started_at            INTEGER,
  last_event_at         INTEGER,
  completed_at          INTEGER,
  error                 TEXT
);

CREATE INDEX IF NOT EXISTS idx_turn_runs_session
  ON turn_runs(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_turn_runs_status
  ON turn_runs(status, last_event_at);
