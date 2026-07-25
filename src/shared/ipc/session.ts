/**
 * session domain IPC 契约。
 */
import type { EffortLevel, NormalizedMessage, PermissionMode } from '../backend/types'
import type { BackendId } from '../constants'
import type { SessionView } from '../domain'

export interface CreateSessionArgs {
  workspaceId: string
  backend?: BackendId
  cwd: string
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
  initialPrompt?: string
}

/**
 * 运行时配置快照——后端 / 模型 / 权限模式 / 思考强度。
 *
 * 两层持久化：
 *   - session 级：sqlite sessions 表的 model/effort/permission_mode/backend 字段
 *     （切历史会话时恢复成那个会话当时的配置）
 *   - 全局 last-used：app_state[LAST_RUNTIME_CONFIG] 存的 RuntimeConfigSnapshot JSON
 *     （新建会话时作为默认值，反映用户"最近一次"的选择）
 *
 * 全部字段允许 null——session 表字段可能为 null（老数据 / 导入会话），
 * last-used 也可能未初始化；调用方需对 null 兜底。
 */
export interface RuntimeConfigSnapshot {
  backend: BackendId
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode | null
}

/** 「扫描导入」扫到的单条 importable session */
export interface ImportableSession {
  backend: BackendId
  backendThreadId: string
  title: string | null
  lastActiveAt: number
  model: string | null
  /** claude only：反推出的 cwd */
  cwd?: string
  /** claude only：jsonl 文件大小 */
  sizeBytes?: number
  /** 是否已在 db（任意 workspace） */
  alreadyImported: boolean
  /** alreadyImported=true 时所在 workspace id */
  existingWorkspaceId?: string
  /** claude only：反推 cwd 精确匹配到的 workspace id */
  matchedWorkspaceId?: string
}

export interface ScanImportableResult {
  sessions: ImportableSession[]
  /** claude 反推 cwd 无法精确匹配任何 workspace 的条数（不含 alreadyImported） */
  unmatchedCount: number
  /** 当前后端扫描失败时的错误（如 codex 进程未启动）。单后端模式下最多 1 条 */
  errors: Array<{ backend: BackendId; error: string }>
}

/**
 * 单条导入项——用户在 dialog 里勾选 + 选好 workspace 后产出。
 *
 * title / lastActiveAt / model 直接用 scanImportable 扫描时拿到的值，避免
 * importSessions 再为每条会话调一次 getHistory（codex 的 getHistory 不返回
 * aiTitle，会 fallback 成 UUID 前缀，导致标题错误；claude 也能省一次磁盘读）。
 * 字段都允许 null/undefined 兜底——调用方可能没填，importSessions 会 fallback。
 */
export interface ImportSessionItem {
  backend: BackendId
  backendThreadId: string
  workspaceId: string
  /** 扫描时拿到的标题（codex 的 name/preview；claude 的 jsonl 头）。null 时 fallback */
  title?: string | null
  /** 扫描时拿到的最后活跃时间（毫秒）。用于导入后排序正确 */
  lastActiveAt?: number
  /** 扫描时拿到的模型 */
  model?: string | null
}

export interface ImportSessionArgs {
  sessions: ImportSessionItem[]
}

export interface ImportSessionsResult {
  imported: SessionView[]
  skipped: Array<{ backendThreadId: string; reason: string }>
}

export type SessionHandlers = {
  /**
   * 读取工作区会话列表——只返回指定 backend 的会话（按当前选中后端过滤）。
   *
   * 渲染层传 backendStore.currentId，切换后端时由 SessionList 的 watch 触发重拉，
   * 这样列表始终只展示当前后端的会话，避免 claude / codex 混排。
   */
  'session.list': (args: { workspaceId: string; backend: BackendId }) => Promise<SessionView[]>
  'session.create': (args: CreateSessionArgs) => Promise<{ sessionId: string }>
  'session.remove': (args: { sessionId: string }) => Promise<void>
  'session.reconcile': (args: { workspaceId: string }) => Promise<{
    added: SessionView[]
    removed: string[]
  }>
  /**
   * 扫描当前后端在磁盘/RPC 上存在、但 catmax db 还未登记的会话（只扫当前 backend）。
   *
   * - claude：扫 ~/.claude/projects/<encoded-cwd>/*.jsonl（由当前 backend 的 adapter 决定）
   * - codex：调 thread/list（不传 cwd，拿全部 thread）
   *
   * 返回每条会话 + 标记：
   * - alreadyImported：是否已在 db（任意 workspace）
   * - matchedWorkspaceId（claude only）：反推 cwd 精确匹配到的 workspace，没有则 undefined
   *
   * 单后端扫描失败时记录到 errors 数组（运行时最多 1 条），不抛错，让 dialog 降级展示。
   */
  'session.scanImportable': () => Promise<ScanImportableResult>
  'session.import': (args: ImportSessionArgs) => Promise<ImportSessionsResult>
  'session.detail': (args: { sessionId: string }) => Promise<{
    session: SessionView
    messages: NormalizedMessage[]
    /**
     * 后端给的会话标题（claude jsonl 里的 aiTitle）。
     * 为 null 表示后端明确表示无标题；为 undefined 表示后端没给（保持现状）。
     * sessionStore 拿到非 null/非空值时回写到 db + UI。
     */
    aiTitle?: string | null | undefined
  }>
  /**
   * 读取子 Agent（Task 工具调用）的完整会话历史。
   *
   * 用于 TaskCard 完成后展开按钮点击，把子 Agent 的每一步（Read/Edit/Bash/文本）
   * 嵌入为可折叠的子会话视图，把子 Agent 从黑盒变成可回放。
   *
   * 子 Agent jsonl 路径：~/.claude/projects/<encoded-cwd>/subagents/agent-<agentId>.jsonl
   */
  'session.readSubagentHistory': (args: {
    /** 后端类型（只有 claude 有子 agent） */
    backend: BackendId
    /** 子 agent id（从 taskStats.agentId 拿到） */
    agentId: string
    /** 工作区目录（推算 claude projects 目录） */
    cwd: string
  }) => Promise<NormalizedMessage[]>
  /**
   * 写回某个 session 的运行时配置（model / effort / permissionMode）。
   *
   * 触发时机：用户在 Composer 改 model/effort/permissionMode 时，
   * 除了更新 last-used 全局缓存，也写回当前 session 的 db 字段——
   * 这样下次切回这个 session 能恢复到用户最后一次在这个 session 里用的配置。
   *
   * backend 不在这里写——session.backend 是会话固有属性，
   * 只在 createSession 时确定，之后不可变。
   */
  'session.updateConfig': (args: {
    sessionId: string
    model?: string | null
    effort?: EffortLevel | null
    permissionMode?: PermissionMode | null
  }) => Promise<void>
  /** 读最近一次运行时配置快照（新建会话默认）。文件未初始化时返回 null。 */
  'session.getLastRuntimeConfig': () => Promise<RuntimeConfigSnapshot | null>
  /** 覆盖写最近一次运行时配置快照。 */
  'session.setLastRuntimeConfig': (args: RuntimeConfigSnapshot) => Promise<void>
}

/** session 推送事件 payload */
export type SessionPushEvents = {
  /** claude turn 完成后从 jsonl 读到 aiTitle 并回写 db，告知 renderer 刷新侧边栏标题 */
  'session:titleChanged': { sessionId: string; title: string }
}
