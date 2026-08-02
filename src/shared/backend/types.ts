/**
 * 后端抽象的跨进程类型契约。
 * main 和 renderer 都 import 这里——renderer 永远只用这些类型，
 * 绝不见 codex/claude 协议原文。
 */
import type { BackendId } from '../constants'

import type { ContentBlock } from './blocks'
import type { ContextBlock } from './context-tag-types'
import type { SlashCommandInfo } from './slash-commands'

// re-export：renderer/main 已经按惯例从 types.ts 引所有 NormalizedMessage 相关类型，
// ContextBlock 也走同一入口，避免到处改 import 路径。
export type { ContextBlock } from './context-tag-types'

/** 权限模式 —— codex 和 claude 语义一致 */
export type PermissionMode =
  'default' | 'acceptEdits' | 'auto' | 'plan' | 'dontAsk' | 'bypassPermissions'

/**
 * 推理强度 —— 取两边并集，每模型支持子集。
 *
 * `'none'` = 关闭/压低 reasoning：
 *   - codex：turn/start effort='none'，产生零 reasoning token（真正关闭）。
 *   - claude：映射到 `--effort low`（CLI 无 --thinking off flag，只能压低）。
 */
export type EffortLevel = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

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
  /** 支持 turn 进行中热切换 model/effort/permissionMode（SDK streaming-input 模式） */
  supportsHotSwap: boolean
  /** UI 展示能力；避免 renderer 根据 backend id 猜特性。 */
  chat: {
    subAgents: boolean
    compact: boolean
    planMode: boolean
    webTools: boolean
    blockTypes: string[]
  }
}

/** 运行中 turn 的配置热切换请求 */
export interface TurnConfigUpdate {
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
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
  displayName?: string
  pluginVersion?: string
  available: boolean
  version: string | null
  error: string | null
  capabilities: BackendCapabilities
}

/** 启动会话参数 */
export interface StartSessionArgs {
  cwd: string
  workspaceFolders?: WorkspaceFolderContext[]
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
  initialPrompt?: string
}

/** 后端预热参数。预热只建立共享缓存，不创建 Catmax 用户会话。 */
export interface WarmupBackendArgs {
  cwd: string
  workspaceFolders?: WorkspaceFolderContext[]
  model?: string
  effort?: EffortLevel
}

/** 启动 turn 参数 */
/**
 * 用命令而不是用户文本发起的一轮 turn。
 *
 * 为什么走 StartTurnArgs 而不是新开一个旁路方法：codex 的 `thread/compact/start`
 * **实测会发出 `turn/started` 和 `item/started`**——它就是一个 turn。绕过 startTurn
 * 直接发这个 RPC，事件会挂在 PerTurnCoordinator 不认识的 turnId 上，于是 watchdog、
 * cooperative cancel、exactly-one-terminal 三个保证同时失效，而且绕过 per-session
 * 串行化：compact 会跟用户正在跑的 turn 并发。当成 turn 走，这些全部自动继承。
 *
 * 只有把斜杠命令实现成**动作**的后端才用得上（codex）。claude 的斜杠命令是文本，
 * CLI 自己拦截，走普通 prompt 即可，不设 command。
 */
export type TurnCommand = {
  /** 压缩上下文。codex → thread/compact/start */
  kind: 'compact'
}

export interface StartTurnArgs {
  /**
   * backend 内部线程 id——claude 用它作 `--resume <id>`，codex 用它 thread/send。
   * 跟 catmax 自己的 session.id（db 主键）不是一回事：claude 第一次 startSession 时
   * 这里只是占位 UUID，等 claude 返回真实 session_id 后 db 的 backend_thread_id
   * 才会被回写。
   */
  sessionId: string
  /**
   * catmax 自己的 session.id（db 主键），仅用于 envelope 路由——
   * renderer 的 messageStore 按 clientSessionId 把流式 events 累积到对应 session 状态。
   * 不传时 fallback 到 sessionId（保持向后兼容）。
   *
   * 不能直接复用 sessionId：renderer 的 currentSessionId 是 catmax session.id，
   * 而 sessionId 是 backendThreadId，两者 key 不同会导致 applyEvent 路由到错误的 session。
   */
  clientSessionId?: string
  prompt: string
  /**
   * 工作区目录（claude 用作 spawn 的 cwd；codex 在 thread/start 时已传，这里冗余但无害）。
   * claude 是 per-turn process 模型——每个 turn 都要 spawn 新 claude 进程，
   * 必须知道在哪个目录跑，否则 claude 会用 main 进程的 cwd，导致：
   *   1) 文件操作工具（Read/Edit/Bash）作用在错误目录
   *   2) 历史文件 ~/.claude/projects/<encoded-cwd>/ 存错地方，--resume 找不到
   */
  cwd?: string
  workspaceFolders?: WorkspaceFolderContext[]
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
  /**
   * 把这一轮当作命令执行，而不是把 prompt 发给模型。
   *
   * 设了它，adapter 应忽略 prompt 的语义（prompt 仍会带着可读文本如 `/compact`，
   * 供 turn_runs 列表和会话预览显示，别让记录里出现空字符串）。
   * adapter 不认识某个 kind 时应当报错而不是静默降级成普通消息——静默降级的表现
   * 是"命令发出去了，模型茫然地回问你要干什么"，比直接报错难查得多。
   */
  command?: TurnCommand
}

export interface WorkspaceFolderContext {
  id: string
  path: string
  alias: string
  role: 'primary' | 'secondary'
}

/** 工具调用描述（归一化） */
export interface ToolCallInfo {
  kind: 'shell_command' | 'file_edit' | 'file_read' | 'mcp' | 'control' | 'web' | 'task' | 'other'
  title: string
  detail?: string
  /**
   * file_edit only：结构化编辑数据，前端用来渲染红绿 diff（优先于 detail）。
   * 后端 mapping 层从 claude Edit/Write/MultiEdit input 或 codex file_change.diff 提取。
   * 没有这个字段时前端回退到把 detail 当纯文本展示。
   */
  edit?: ToolEditInfo
  /**
   * 控制流工具的结构化数据（EnterPlanMode / ExitPlanMode / TodoWrite）。
   * 这些工具的 input 不是文件/命令，而是 plan markdown / todos——
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
  /** 子 Agent 类型（Agent 工具入参 subagent_type），启动时即可知，不必等完成统计。 */
  subagentType?: string
  /**
   * 子 Agent 完成统计（agentId / 耗时 / token / 工具分类计数）。
   * 实时流路径由 messageStore 从 tool_call_completed.taskStats 合并；
   * 历史回放路径由 history-mapping 从 user 消息顶层 tool_use_result 合并。
   * 完成前为 undefined（TaskCard 显示 running 态）。
   */
  stats?: ToolTaskStats
}

/**
 * Task（子 Agent）完成统计--从 user 消息的 tool_use_result 字段提取。
 *
 * 来源：claude CLI 在子 Agent 完成时给 tool_result 附加的顶层元数据。
 * 包含总耗时 / token 数 / 工具调用次数 / 工具分类计数。
 *
 * 前端用来在 TaskCard 完成态显示"153s · 31.6k tokens · 5 次工具调用"这类摘要，
 * 让子 Agent 不再是完全黑盒。
 */
export interface ToolTaskStats {
  /** 子 Agent id，用于读 ~/.claude/projects/.../subagents/agent-<id>.jsonl */
  agentId?: string
  /** 后台子 Agent 的真实生命周期状态。 */
  status?: 'running' | 'completed' | 'failed' | 'stopped'
  /** 子 Agent 总耗时（毫秒） */
  totalDurationMs?: number
  /** 子 Agent 总 token 数（input + output + cache） */
  totalTokens?: number
  /** 子 Agent 内部工具调用总次数 */
  totalToolUseCount?: number
  /** 子 Agent 类型（"general-purpose" / "Explore" / ...） */
  agentType?: string
  /** SDK 周期性生成的进度摘要。 */
  progressSummary?: string
  /** 子 Agent 最近调用的工具名。 */
  lastToolName?: string
  /** 子 Agent 内部工具使用分类计数 */
  toolStats?: {
    readCount?: number
    searchCount?: number
    bashCount?: number
    editFileCount?: number
    linesAdded?: number
    linesRemoved?: number
    otherToolCount?: number
  }
}

/** Claude 后台任务事件的归一化快照。 */
export interface BackgroundTaskSnapshot {
  taskId: string
  toolUseId?: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  description?: string
  summary?: string
  /**
   * SDK 的任务类型标签（'shell' / 'subagent' / 'monitor' / 'workflow' / ...）。
   *
   * Background Tasks Panel: 决定任务的图标与"进度"从哪来——shell 任务 SDK 不给
   * task_progress，唯一的进度是 outputFile 里的命令输出；subagent 则相反。
   */
  taskType?: string
  /**
   * 后台任务输出文件的绝对路径（shell 任务是命令的 stdout/stderr 落盘）。
   *
   * SDK 只在终态的 task_notification 里给 output_file，但 shell 任务恰恰是在
   * *运行中* 才需要它。启动时 Bash 的 tool_result 文本里带同一路径，
   * parseBackgroundOutputFile 把它捞出来，面板才能在任务跑完前 tail 输出。
   */
  outputFile?: string
  /** 首次观测到该任务的时间（Unix ms），面板用来显示"已运行 N 秒"。 */
  startedAt?: number
  /** task_updated 带来的错误原文（SDK 只在这一个消息里给）。 */
  error?: string
  stats: ToolTaskStats
}

/**
 * 控制流工具的结构化数据。
 *
 * 4 种 type 对应 claude 的 4 个控制流工具：
 * - enter_plan_mode：进入计划模式（无数据，纯提示）
 * - exit_plan_mode：退出计划模式 + 携带 markdown 实施方案
 * - todo_write：更新 todo 列表
 */
export interface ToolControlInfo {
  type: 'enter_plan_mode' | 'exit_plan_mode' | 'todo_write'
  /** exit_plan_mode：markdown 计划内容（用户审批的核心） */
  plan?: string
  /** todo_write：todo 列表 */
  todos?: ToolControlTodo[]
}

export interface ToolControlTodo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  /** 当前进行中的简短描述（claude 给的） */
  activeForm?: string
}

/**
 * agent 问用户的问题——自定义 ask_user MCP 工具的入参归一化。
 * 单个问题（ask_user 一次只问一个，不像旧 AskUserQuestion 批量）。
 */
export interface AgentQuestion {
  /** 完整问题文本 */
  question: string
  /** 短标签（≤12 字符），UI 显示为 chip */
  header?: string
  /** 2-4 个互斥选项；为空时纯自由文本问题 */
  options?: AgentQuestionOption[]
  /** 多选允许（default false） */
  multiSelect?: boolean
}

export interface AgentQuestionOption {
  label: string
  description?: string
}

/**
 * 用户对 agent 问题的回答——respondQuestion 的 payload。
 * selectedLabels 为空 + freeText 为空 = 用户跳过（Esc），告诉模型可换问法或继续。
 */
export interface AgentAnswer {
  selectedLabels: string[]
  freeText?: string
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
  /** ExitPlanMode：待用户确认的 Markdown 计划。存在时由计划审批 UI 渲染。 */
  plan?: string
  /**
   * MCP server 明确声明可持久化时才展示对应选项。
   * 普通 command/file approval 不填，继续使用 codex 的 acceptForSession。
   */
  approvalPersistence?: Array<'session' | 'always'>
  /**
   * 以下三项由 Claude Agent SDK 的 canUseTool 回调 options 透传（SDK 原生计算的友好文案）。
   * codex 不填——PermissionPanel 对 undefined 自然回退到 detail 展示。
   */
  /** 友好动作名，如 "Write" / "Read file"，适合做标签/按钮 */
  displayName?: string
  /** 人类可读目标/副标题，如 "/tmp/x.txt" 或 "Claude will have read/write access to ~/Downloads" */
  description?: string
  /** 为什么触发这次权限请求，如 "Path is outside allowed working directories" */
  decisionReason?: string
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
  | {
      type: 'reasoning_delta'
      turnId: string
      itemId: string
      text: string
      completedLabel?: string
    }
  | {
      type: 'content_block_upsert'
      turnId: string
      block: ContentBlock
      /**
       * 原始 backend item id。文本 block 会派生出 `${itemId}-text` 作为 block id，
       * 但消息聚合必须继续使用原始 item id，才能和 text_delta 落到同一条消息。
       */
      itemId?: string
      /**
       * true 表示 block 来自 item/completed，是该 item 的权威最终快照。
       * 某些 HTTP/SSE 路径会在晚到的 delta 之前先送达 completed。
       */
      completed?: boolean
    }
  | {
      type: 'codex_activity_output_delta'
      turnId: string
      itemId: string
      text: string
    }
  | {
      type: 'codex_turn_diff_updated'
      turnId: string
      diff: string
    }
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
      /**
       * Task（子 Agent）完成统计--仅当 tool 是 Task 时存在。
       * 从 user 消息的顶层 tool_use_result 字段提取，让前端在完成态显示
       * "153s · 31.6k tokens · 5 次工具调用"，把子 Agent 从黑盒变成可观测。
       */
      taskStats?: ToolTaskStats
    }
  | {
      /**
       * Claude 后台 Agent 生命周期更新。
       *
       * Agent 工具在 async_launched 时仍是 running；只有 task_notification
       * 才会把它推进 completed / failed / stopped。
       */
      type: 'background_task_updated'
      turnId: string
      task: BackgroundTaskSnapshot
    }
  | {
      /**
       * 子 Agent 内部对话的实时增量。
       *
       * SDK 默认只转发子 Agent 的 tool_use/tool_result（够做心跳计数，不够渲染过程）；
       * 开了 forwardSubagentText 后文本/思考也会转发，全都带 parent_tool_use_id。
       * 这些消息**不能**进主对话流——它们是子 Agent 的内部过程，混进去会让主对话
       * 突然冒出一堆用户没发起过的工具卡片。统一走这个事件挂到发起它的卡片下面。
       */
      type: 'subagent_message'
      turnId: string
      /** 发起该子 Agent 的 tool_use id——UI 用它决定挂到哪张卡片。 */
      parentToolUseId: string
      /** 按 id 合并（同一条 API 消息可能分多次到达），不是无脑追加。 */
      message: NormalizedMessage
    }
  | {
      /** 子 Agent 内部工具调用的结果回填。 */
      type: 'subagent_tool_result'
      turnId: string
      parentToolUseId: string
      toolUseId: string
      output: ToolOutput
    }
  | {
      type: 'approval_requested'
      turnId: string
      requestId: string
      request: ApprovalRequest
      /**
       * 标识来源 backend——renderer 用来决定写哪个 pending slot。
       * - undefined / 'codex'：走 pendingApproval（codex approval）
       * - 'claude'：走 pendingClaudePermission（claude 通过 MCP server 的权限请求）
       * 两者都由 PermissionPanel 渲染。
       */
      source?: BackendId
    }
  | {
      /**
       * agent 问用户问题——claude 调用自定义 ask_user MCP 工具时由 adapter 推送。
       * UI 弹 QuestionPanel（覆盖 Composer 位置），用户回答后走 respondQuestion 回流。
       * （内置 AskUserQuestion 被 isInteractive 门控，headless 下不可用，故用自定义工具替代。）
       */
      type: 'agent_question'
      turnId: string
      /** ask_user handler 的 pending id，respondQuestion 时用它定位 resolver */
      requestId: string
      question: AgentQuestion
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
  /**
   * 新的顺序化渲染契约。迁移期仍接受下方三个旧字段；所有新 mapping 必须写 blocks。
   * renderer 会把旧历史即时升级，数据库中已保存的数据无需迁移。
   */
  blocks?: ContentBlock[]
  textBlocks?: {
    id: string
    text: string
    kind: 'text' | 'reasoning'
    /**
     * reasoning 块专属：首次收到 delta 的时间戳。
     * 用来计算"思考时长"（endedAt - startedAt）。历史消息反推时无此字段。
     */
    startedAt?: number
    /**
     * reasoning 块专属：流式结束时间戳。
     *
     * 触发时机（任一即设置，幂等）：
     *   - 同 turn 内首次收到 text_delta（正文开始 → 思考结束）
     *   - turn_completed（兜底，纯思考无正文的场景）
     *   - 不可恢复的 error
     *
     * 关键设计：reasoning 和 text 通常来自不同 itemId（不同 NormalizedMessage），
     * 所以不能靠"自己是最后一块"判断是否还在流式——必须显式记录结束时间。
     * 前端用 endedAt === undefined 判断"还在思考中"。
     */
    endedAt?: number
  }[]
  toolBlocks?: {
    id: string
    info: ToolCallInfo
    status: 'running' | 'completed' | 'failed'
    output?: ToolOutput
    approvalState?: 'pending' | 'approved' | 'rejected'
    approvalRequestId?: string
    /**
     * 工具调用开始时间戳（收到 tool_call_started 时设置）。
     * 前端用来算"已运行 N 秒"--尤其 Task（子 Agent）可能跑很久，
     * 有个实时计时器让用户知道它真的在跑而不是卡死。
     */
    startedAt?: number
    /**
     * Task（子 Agent）完成统计--仅当 info.kind === 'task' 时存在。
     * 历史回放路径由 history-mapping 从 jsonl 的 tool_use_result 提取；
     * 实时流路径由 messageStore 从 tool_call_completed / background_task_updated 事件写入。
     * 前端 TaskCard 完成态显示"153s · 31.6k tokens · 5 次工具调用"。
     */
    taskStats?: ToolTaskStats
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
  /**
   * 列出该 cwd 下可用的斜杠命令（含项目/用户 Skill），供输入框联想使用。
   *
   * 按 cwd 而不是全局：项目级 Skill 来自 `<cwd>/.claude/skills/`，换目录内容就变。
   * 只有把斜杠命令当**文本**处理的后端才实现——claude 是（CLI 自己拦截 `/xxx`）。
   * codex 不实现：它的斜杠命令是动作（各自对应不同的 JSON-RPC，见 TurnCommand），
   * 而且 app-server 上没有列命令的接口，命令表只能在 renderer 侧手工维护。
   * 不实现 ≠ 该后端没有斜杠命令，只是没有**动态**命令表。
   */
  listSlashCommands?(cwd: string): Promise<SlashCommandInfo[]>
  getCapabilities(): BackendCapabilities

  startSession(args: StartSessionArgs): Promise<{ sessionId: string; backendThreadId: string }>
  /** 可选的后端缓存预热；不得把预热内容写入用户会话。 */
  warmup?(args: WarmupBackendArgs): Promise<void>
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
  /** 响应 agent 的问题（ask_user 工具）。claude 实现；codex 无此能力可不实现。 */
  respondQuestion?(args: { turnId: string; requestId: string; answer: AgentAnswer }): Promise<void>
  steer?(turnId: string, prompt: string): Promise<void>
  /**
   * 单独停止一个后台任务（不影响所在 turn 的其他任务，也不中断整个 turn）。
   *
   * 与 interrupt 的区别：interrupt 停掉整个 turn 连带它的全部后台任务；
   * 这里是后台任务面板上单条任务的"停止"按钮。claude 实现；codex 无后台任务概念。
   */
  stopBackgroundTask?(taskId: string): Promise<void>
  /** 运行中热切换 model/effort/permissionMode（仅 supportsHotSwap 的 backend 实现） */
  updateTurnConfig?(turnId: string, config: TurnConfigUpdate): Promise<void>

  /**
   * 物理删除后端侧的会话数据（用户在 catmax UI 删除会话时调用）。
   *
   * - claude：删 ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl 文件
   * - codex：扫 ~/.codex/sessions/ 下 rollout-<ts>-<threadId>.jsonl 删除（无 RPC 暴露删除）
   *
   * 实现应尽力删除 + 不抛错（失败仅日志），DB 删除不依赖此方法的成功——
   * removeSession 会同时写 tombstone 兜底，即便这里删不掉，reconcile 也不会让它复活。
   */
  deleteSession?(backendThreadId: string, cwd?: string): Promise<void>

  /**
   * Session Fork: 把一个已有会话的历史整份复制成一个新会话，返回新的 backendThreadId。
   *
   * 语义是"分叉"——新旧会话各自独立，之后在副本里聊不影响原会话。
   *
   * - claude：SDK 的 forkSession()，会复制 transcript 并重映射所有 message uuid
   *   与 parentUuid 链（不是简单 cp，否则 uuid 撞车）。
   * - codex：没有 fork RPC，手动复制 rollout 文件——只有首行 session_meta.payload.id
   *   是 thread id，其余行不含 id，所以改首行 + 换文件名即可。
   *
   * 关键前提：fork 出来的会话**不需要**任何 turn 层改动。两个 adapter 都是"磁盘上有
   * 文件就能 resume"：claude 的 startTurn 用 resolveSessionJsonlPath 探测文件决定
   * canResume；codex 的 startTurnRequest 撞 "thread not found" 会自动 thread/resume
   * 重试一次。所以新文件落盘即可用。
   *
   * 不支持的后端不实现此方法，UI 据此隐藏「复制会话」菜单项。
   */
  forkSession?(backendThreadId: string, cwd?: string): Promise<{ backendThreadId: string }>
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
