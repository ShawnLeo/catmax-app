/**
 * 后端抽象的跨进程类型契约。
 * main 和 renderer 都 import 这里——renderer 永远只用这些类型，
 * 绝不见 codex/claude 协议原文。
 */
import type { BackendId } from '../constants'
import type { ContextBlock } from './context-tag-types'

// re-export：renderer/main 已经按惯例从 types.ts 引所有 NormalizedMessage 相关类型，
// ContextBlock 也走同一入口，避免到处改 import 路径。
export type { ContextBlock } from './context-tag-types'

/** 权限模式 —— codex 和 claude 语义一致 */
export type PermissionMode =
  'default' | 'acceptEdits' | 'auto' | 'plan' | 'dontAsk' | 'bypassPermissions'

/** 推理强度 —— 取两边并集，每模型支持子集 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** 后端能力声明 */
export interface BackendCapabilities {
  supportsInterrupt: boolean
  supportsApproval: boolean
  supportsSteer: boolean
  supportsThreadFork: boolean
  supportsModelSelection: boolean
  supportsEffort: boolean
  supportsPermissionMode: boolean
  supportedPermissionModes: PermissionMode[]
  supportedEfforts: EffortLevel[]
}

/** 模型选项 —— 由 Adapter 从后端动态拉取 */
export interface ModelOption {
  id: string
  displayName: string
  backendSpecific?: boolean
  supportedEfforts?: EffortLevel[]
  isDefault?: boolean
  description?: string
}

/** 后端连接状态 */
export interface BackendStatus {
  id: BackendId
  available: boolean
  version: string | null
  error: string | null
  capabilities: BackendCapabilities
}

/** 启动会话参数 */
export interface StartSessionArgs {
  cwd: string
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
  initialPrompt?: string
}

/** 启动 turn 参数 */
export interface StartTurnArgs {
  sessionId: string
  prompt: string
  /**
   * 工作区目录（claude 用作 spawn 的 cwd；codex 在 thread/start 时已传，这里冗余但无害）。
   * claude 是 per-turn process 模型——每个 turn 都要 spawn 新 claude 进程，
   * 必须知道在哪个目录跑，否则 claude 会用 main 进程的 cwd，导致：
   *   1) 文件操作工具（Read/Edit/Bash）作用在错误目录
   *   2) 历史文件 ~/.claude/projects/<encoded-cwd>/ 存错地方，--resume 找不到
   */
  cwd?: string
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
}

/** 工具调用描述（归一化） */
export interface ToolCallInfo {
  kind:
    | 'shell_command'
    | 'file_edit'
    | 'file_read'
    | 'mcp'
    | 'control'
    | 'web'
    | 'task'
    | 'other'
  title: string
  detail?: string
  /**
   * file_edit only：结构化编辑数据，前端用来渲染红绿 diff（优先于 detail）。
   * 后端 mapping 层从 claude Edit/Write/MultiEdit input 或 codex file_change.diff 提取。
   * 没有这个字段时前端回退到把 detail 当纯文本展示。
   */
  edit?: ToolEditInfo
  /**
   * 控制流工具的结构化数据（EnterPlanMode / ExitPlanMode / TodoWrite / AskUserQuestion）。
   * 这些工具的 input 不是文件/命令，而是 plan markdown / todos / questions——
   * 前端按 control.type 分发到专门渲染组件，不走 detail/output 默认渲染。
   */
  control?: ToolControlInfo
  /**
   * web 工具的结构化数据（WebSearch / WebFetch）。
   * - WebSearch：query + 可选 allowed_domains/blocked_domains（title + detail 也填了，但 web 优先渲染）
   * - WebFetch：url + 可选 prompt
   * output（结果摘要 / 抓取内容）仍走 ToolOutput，前端按 markdown 渲染。
   */
  web?: ToolWebInfo
  /**
   * Task 工具的结构化数据（子 agent 调用）。
   * 展示子 agent 的 description + prompt 摘要（不展开子 agent 内部的 tool calls——
   * 那需要嵌套子会话视图，工作量大；先做摘要版）。
   */
  task?: ToolTaskInfo
}

/**
 * Web 工具结构化数据。
 *
 * 两种 type：
 * - `search`：WebSearch，query + 域名过滤
 * - `fetch`：WebFetch，url + prompt 指令
 */
export interface ToolWebInfo {
  type: 'search' | 'fetch'
  /** search: 搜索关键词；fetch: 抓取的 URL */
  query: string
  /** fetch only：给抓取器的 prompt（聚焦抓取内容的指令） */
  prompt?: string
  /** search only：只搜这些域名 */
  allowedDomains?: string[]
  /** search only：不搜这些域名 */
  blockedDomains?: string[]
}

/**
 * Task 工具结构化数据（子 agent 调用）。
 */
export interface ToolTaskInfo {
  /** 子 agent 类型描述（"general-purpose" / "Explore" / 自定义） */
  description: string
  /** 给子 agent 的完整 prompt（可能很长，前端截断展示） */
  prompt: string
}

/**
 * 控制流工具的结构化数据。
 *
 * 4 种 type 对应 claude 的 4 个控制流工具：
 * - enter_plan_mode：进入计划模式（无数据，纯提示）
 * - exit_plan_mode：退出计划模式 + 携带 markdown 实施方案
 * - todo_write：更新 todo 列表
 * - ask_user_question：向用户提问（多选项）
 */
export interface ToolControlInfo {
  type: 'enter_plan_mode' | 'exit_plan_mode' | 'todo_write' | 'ask_user_question'
  /** exit_plan_mode：markdown 计划内容（用户审批的核心） */
  plan?: string
  /** todo_write：todo 列表 */
  todos?: ToolControlTodo[]
  /** ask_user_question：问题列表 */
  questions?: ToolControlQuestion[]
}

export interface ToolControlTodo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  /** 当前进行中的简短描述（claude 给的） */
  activeForm?: string
}

export interface ToolControlQuestion {
  header: string
  question: string
  options: ToolControlQuestionOption[]
}

export interface ToolControlQuestionOption {
  label: string
  description: string
}

/**
 * 文件编辑的结构化数据——前端 DiffView 用来渲染真正的 diff（红绿块），不是 JSON.stringify。
 *
 * 三种来源对应三种 type：
 * - `unified_diff`：codex 的 file_change item 自带标准 unified diff 文本（@@ ... @@ + 行级 +/-）
 * - `string_replace`：claude Edit 工具——一组 old_string → new_string
 * - `full_content`：claude Write 工具——整文件覆盖（没有"old"概念，展示完整新内容）
 *
 * MultiEdit 走 `edits` 数组（多组 string_replace）。
 */
export interface ToolEditInfo {
  type: 'unified_diff' | 'string_replace' | 'full_content'
  /** 被编辑的文件路径（用于 header 显示） */
  filePath: string
  /** type === 'unified_diff'：标准 git diff 文本 */
  diff?: string
  /** type === 'string_replace'：单组替换的原文 */
  oldString?: string
  /** type === 'string_replace'：单组替换的新文 */
  newString?: string
  /** type === 'full_content'：完整新文件内容 */
  content?: string
  /** MultiEdit：多组替换（type 仍是 'string_replace'，前端遍历渲染多块） */
  edits?: Array<{ oldString: string; newString: string }>
}

/** 工具输出（归一化） */
export interface ToolOutput {
  ok: boolean
  summary: string
  output?: string
}

/** approval 请求（归一化） */
export interface ApprovalRequest {
  kind: 'shell_command' | 'file_edit' | 'mcp'
  title: string
  detail: string
  riskLevel: 'low' | 'medium' | 'high'
}

/** approval 决策 */
export interface ApprovalDecision {
  requestId: string
  action: 'approve' | 'reject' | 'approve_always'
}

/** Token 用量 */
export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  costUsd?: number
}

/**
 * TurnEvent —— Adapter 输出的归一化事件流。
 * BackendManager 把这些事件经 IPC 推到 renderer。
 */
export type TurnEvent =
  | { type: 'turn_started'; turnId: string; sessionId: string }
  | { type: 'text_delta'; turnId: string; itemId: string; text: string }
  | { type: 'reasoning_delta'; turnId: string; itemId: string; text: string }
  | {
      type: 'tool_call_started'
      turnId: string
      itemId: string
      tool: ToolCallInfo
    }
  | {
      type: 'tool_call_completed'
      turnId: string
      itemId: string
      output: ToolOutput
    }
  | {
      type: 'approval_requested'
      turnId: string
      requestId: string
      request: ApprovalRequest
    }
  | { type: 'error'; turnId: string; message: string; recoverable: boolean }
  | {
      type: 'turn_completed'
      turnId: string
      status: 'completed' | 'interrupted' | 'error'
      usage?: TokenUsage
    }

/** 渲染层归一化消息（UI 永远只见这个） */
export interface NormalizedMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  turnId: string
  textBlocks?: {
    id: string
    text: string
    kind: 'text' | 'reasoning'
  }[]
  toolBlocks?: {
    id: string
    info: ToolCallInfo
    status: 'running' | 'completed' | 'failed'
    output?: ToolOutput
    approvalState?: 'pending' | 'approved' | 'rejected'
    approvalRequestId?: string
  }[]
  /**
   * Context tag 块（IDE selection / opened file / environment_context 等）。
   * 由 history-mapping 或 messageStore.pushUserMessage 在 user 文本里提取得到。
   * 跟 textBlocks / toolBlocks 平级，UI 按 tag 类型分发到对应组件渲染。
   * 不在 user 消息上时省略（向后兼容旧消息）。
   */
  contextBlocks?: ContextBlock[]
  createdAt: number
}

/** AgentBackend 接口 —— 所有 Adapter 实现这个 */
export interface AgentBackend {
  readonly id: BackendId
  readonly capabilities: BackendCapabilities

  initialize(): Promise<void>
  healthCheck(): Promise<{ ok: boolean; version?: string; error?: string }>
  dispose(): Promise<void>

  listModels(): Promise<ModelOption[]>
  /**
   * 清掉 listModels() 的内部缓存（如果 adapter 有的话）。
   * 下次 listModels() 会重新拉。无缓存的 adapter（如 claude）可以不实现。
   *
   * 触发时机：
   * - 用户切换 backend（切回来时模型列表可能已变，如换了登录账户）
   * - applySettings 改了 binaryPath（codex 升级了版本）
   * - 用户点了 UI 上的"刷新模型"按钮
   */
  invalidateModelsCache?(): void
  getCapabilities(): BackendCapabilities

  startSession(args: StartSessionArgs): Promise<{ sessionId: string; backendThreadId: string }>
  listSessions(cwd?: string): Promise<SessionSummary[]>
  resumeSession(backendThreadId: string): Promise<{ messages: NormalizedMessage[] }>

  /** 读取会话历史（用于 UI 回放，不影响后端状态） */
  getHistory(
    backendThreadId: string,
    cwd?: string,
  ): Promise<{ messages: NormalizedMessage[]; aiTitle?: string | null }>

  startTurn(args: StartTurnArgs): AsyncIterable<TurnEvent>

  interrupt(turnId: string): Promise<void>
  respondApproval(decision: ApprovalDecision): Promise<void>
  steer?(turnId: string, prompt: string): Promise<void>
}

/** 会话摘要（跨进程共享） */
export interface SessionSummary {
  backendThreadId: string
  title: string | null
  lastActiveAt: number
  model: string | null
  /** claude only：磁盘上反推出的 cwd（jsonl 文件所在项目目录名 decode 回来），
   *  用于「扫描导入」时与已注册 workspace 路径匹配。codex thread/list 不返回此字段。 */
  cwd?: string
  /** claude only：jsonl 文件大小（字节），导入 UI 显示用 */
  sizeBytes?: number
}

/** Adapter 抛的错误 */
export class BackendError extends Error {
  constructor(
    public code:
      | 'not-initialized'
      | 'not-installed'
      | 'not-logged-in'
      | 'mismatch'
      | 'protocol'
      | 'spawn-failed'
      | 'timeout',
    message: string,
    public override cause?: unknown,
  ) {
    super(message)
    this.name = 'BackendError'
  }
}
