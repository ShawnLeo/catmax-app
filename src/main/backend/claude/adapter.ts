/**
 * Claude 后端 adapter —— 基于 Agent SDK（@anthropic-ai/claude-agent-sdk）。
 *
 * 历史背景：本文件原是 per-turn spawn `claude` CLI + 解析 stream-json stdout 的实现。
 * 现已迁移到 Agent SDK：SDK 内部仍 spawn 一个 bundled claude binary，但通过 typed
 * 的 SDKMessage 流 + canUseTool 进程内回调，消除了 ApprovalBridge / Unix socket / MCP
 * server 子进程 / 临时 mcp-config 那一整套机制。
 *
 * 设计契约：
 * - 每次 startTurn 调一次 query()，迭代 SDKMessage 流 → 转 TurnEvent yield
 * - 权限：options.canUseTool 回调 → push approval_requested 事件 → await 用户决策
 * - interrupt：ctx.query.interrupt()（SDK 原生，比 SIGTERM 优雅）
 * - 会话连续性：options.resume: claudeSessionId（等价 CLI 的 --resume）
 * - binary 解析：dev 模式 SDK 自行 resolve；packaged 模式传 pathToClaudeCodeExecutable
 *   指向 app.asar.unpacked 里的真实路径（PoC 验证见 docs/Agent SDK Electron 打包 PoC 验证报告.md）
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'

import {
  deleteSession as deleteSdkSession,
  query,
  type CanUseTool,
  type ModelInfo,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { CLAUDE_CAPABILITIES } from '@shared/backend/builtin-capabilities'
import {
  BackendError,
  type AgentAnswer,
  type AgentBackend,
  type ApprovalDecision,
  type BackendCapabilities,
  type EffortLevel,
  type ModelOption,
  type NormalizedMessage,
  type SessionSummary,
  type StartSessionArgs,
  type StartTurnArgs,
  type TurnConfigUpdate,
  type TurnEvent,
  type WarmupBackendArgs,
} from '@shared/backend/types'
import { app } from 'electron'

import { logger } from '../../service/logger'

import { createAskUserServer } from './ask-user-server'
import {
  listClaudeSessionsFromDisk,
  readHistoryFromJsonl,
  resolveSessionJsonlPath,
} from './jsonl-reader'
import { claudePermissionToApprovalRequest } from './mapping'
import {
  SdkPartialAggregator,
  isSdkAssistantMessage,
  isSdkPartialMessage,
  isSdkResultMessage,
  isSdkSystemMessage,
  isSdkUserMessage,
  sdkAssistantToEvents,
  sdkResultToEvent,
  sdkSystemSessionId,
  sdkUserToolResultToEvents,
} from './sdk-mapping'

const log = logger.domain('claude-adapter')
const WARMUP_CACHE_TTL_MS = 4 * 60 * 1000
const WARMUP_TIMEOUT_MS = 30_000
const WARMUP_PROMPT = 'Warmup. Reply with exactly "ready" and do not use any tools.'

/**
 * ask_user 工具的 system prompt 引导语——追加到 Claude Code 默认 system prompt 之后。
 * 用 Options.systemPrompt: { type:'preset', preset:'claude_code', append } 注入，
 * 不覆盖默认 prompt（保留所有工具指令）。
 *
 * 目的：让模型在请求模糊/需要偏好决策时主动调 ask_user 问用户，而不是直接猜。
 */
const ASK_USER_GUIDE = `## Asking the user questions with ask_user

You have an "ask_user" tool (mcp__catmax__ask_user). When the user's request is ambiguous or a meaningful choice is involved (which library/approach/scope to use, a preference, a trade-off), do NOT guess or pick a default — call ask_user to ask ONE clarifying question first. Provide 2-4 concise, mutually exclusive options. The user can always type a free-form answer instead of choosing, so never add an "Other" option. Ask only the single most important question; if you need multiple answers, ask sequentially. After receiving the answer, proceed accordingly.`

// ============ per-turn 上下文 ============

interface TurnContext {
  /** SDK 的 Query 对象（async iterable + interrupt/setModel/setPermissionMode 等控制方法） */
  query: Query
  /** AbortController，用于 dispose 时强制中断 */
  abortController: AbortController
  /**
   * pending 权限审批：requestId → { resolver, suggestions }。requestId 格式 `${turnId}:${nonce}`。
   * suggestions 是 SDK canUseTool 给的 PermissionUpdate[]，approve_always 时作为 updatedPermissions 回传，
   * 让"本会话都允许"真正生效（否则 SDK 不知道要持久化规则，下次还会问）。
   */
  pendingApprovals: Map<
    string,
    {
      resolve: (action: ApprovalDecision['action']) => void
      suggestions?: PermissionUpdate[] | undefined
    }
  >
  /** 是否已被 interrupt（避免重复中断） */
  interrupted: boolean
  /** 当前 turn 对应的 catmax session id（用于回填 sessionIdMap） */
  sessionId: string
  /** streaming-input 的输入控制句柄：close() 让输入迭代器结束，query 自然完成 */
  inputController: { close: () => void }
  /**
   * ask_user MCP server 句柄——提供 agent 问用户问题的能力。
   * respondQuestion 用它把用户的回答 resolve 给阻塞中的 handler。
   * rejectAll 在 turn 结束时兜底，避免 handler 永远阻塞。
   */
  askUser: {
    respondQuestion: (requestId: string, answer: AgentAnswer) => boolean
    rejectAll: () => void
  }
}

// ============ adapter 选项 ============

export interface ClaudeAdapterOptions {
  cwd?: string
  /** claude 返回真实 session_id 时触发（manager 用来回写 db backend_thread_id） */
  onRealSessionId?: (internalId: string, realSessionId: string) => void
}

// ============ ClaudeAdapter ============

export class ClaudeAdapter implements AgentBackend {
  readonly id = 'claude' as const

  readonly capabilities = CLAUDE_CAPABILITIES

  private opts: ClaudeAdapterOptions
  /** turnId → TurnContext（支持多 turn 并发） */
  private turnContexts = new Map<string, TurnContext>()
  /** catmax 内部 session id → claude 真实 session id（首次 turn 后由 system.init 回填） */
  private sessionIdMap = new Map<string, string>()
  /** 已拿到 claude 真实 session_id 的 session（决定能否 resume） */
  private resumableSessions = new Set<string>()
  /** 额外 env（代理设置等），注入到 SDK query 的 options.env */
  private extraEnv: Record<string, string> = {}
  /**
   * 可用模型列表缓存（首次 query 后从 initializationResult 拿到）。
   * undefined = 还没拿到过，listModels 返回静态 fallback。
   */
  private modelsCache: ModelInfo[] | undefined
  /**
   * Prompt-cache 预热按 cwd/model/effort 去重。这里缓存的是临时 Warmup turn，
   * 与任何 Catmax 用户会话无关；完成后对应的 Claude JSONL 会被删除。
   */
  private warmups = new Map<string, { promise: Promise<void>; warmedAt: number | null }>()

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.opts = opts
  }

  // ---- 向后兼容：manager 通过 setBinaryPath/setExtraEnv 注入设置 ----
  // SDK 自带 binary，setBinaryPath 不再生效，但保留空实现避免 manager 报错。
  setBinaryPath(_path: string): void {
    log.info('setBinaryPath ignored — Agent SDK bundles its own binary')
  }

  setExtraEnv(env: Record<string, string>): void {
    this.extraEnv = env
  }

  async initialize(): Promise<void> {
    log.info('initialized (lazy, per-turn via SDK query)')
  }

  async healthCheck(): Promise<{ ok: boolean; version?: string; error?: string }> {
    // SDK 模式下 binary 是 bundled 的，不做 --version spawn 检查。
    // 真正的可用性在首次 query 时验证（system.init 到达 = binary 可用 + auth 有效）。
    // 这里返回乐观结果，让 UI 不阻塞；如果 binary 缺失，首次发消息会报错。
    return { ok: true }
  }

  async dispose(): Promise<void> {
    const turnIds = [...this.turnContexts.keys()]
    for (const id of turnIds) {
      const ctx = this.turnContexts.get(id)
      if (ctx) {
        ctx.interrupted = true
        ctx.abortController.abort()
      }
    }
    if (turnIds.length > 0) {
      log.info('dispose: aborted', turnIds.length, 'running turn(s)')
    }
    this.turnContexts.clear()
  }

  getCapabilities(): BackendCapabilities {
    return this.capabilities
  }

  async listModels(): Promise<ModelOption[]> {
    // 有动态缓存（首次 query 后从 SDK initializationResult 拿到）→ 返回真实列表
    if (this.modelsCache && this.modelsCache.length > 0) {
      return this.modelsCache.map((m) => ({
        id: m.value,
        displayName: m.displayName,
        ...(m.description ? { description: m.description } : {}),
        ...(m.supportedEffortLevels
          ? { supportedEfforts: this.mapEffortLevels(m.supportedEffortLevels) }
          : {}),
      }))
    }
    // 无缓存（尚未跑过 query）→ 静态 fallback，保证 UI 初始有选项
    return [
      { id: 'sonnet', displayName: 'Sonnet (latest)', isDefault: true },
      { id: 'opus', displayName: 'Opus (latest)' },
      { id: 'haiku', displayName: 'Haiku (latest)' },
    ]
  }

  invalidateModelsCache(): void {
    this.modelsCache = undefined
  }

  /** SDK 的 effort 等级 → catmax 的 EffortLevel（补 'none'） */
  private mapEffortLevels(levels: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[]): EffortLevel[] {
    return ['none', ...levels]
  }

  async startSession(
    args: StartSessionArgs,
  ): Promise<{ sessionId: string; backendThreadId: string }> {
    const sessionId = randomUUID()
    this.sessionIdMap.set(sessionId, sessionId) // 占位，首次 turn 后回填真实 id
    void args
    return { sessionId, backendThreadId: sessionId }
  }

  /**
   * Claude Code 风格的 cache warmup。
   *
   * Agent SDK 没有单独的 initialize-only API，因此用一次最小真实 query 提前写入
   * system prompt / tool schema 的 prompt cache。关键区别是使用独立 sessionId，
   * 并在完成后通过 SDK deleteSession 删除 transcript，绝不 resume 到用户会话。
   */
  async warmup(args: WarmupBackendArgs): Promise<void> {
    const key = `${args.cwd}\0${args.model ?? ''}\0${args.effort ?? ''}`
    const existing = this.warmups.get(key)
    if (existing) {
      if (existing.warmedAt === null) {
        log.info('warmup joined in-flight request', {
          cwd: args.cwd,
          model: args.model ?? 'default',
          effort: args.effort ?? 'default',
        })
        return existing.promise
      }
      const ageMs = Date.now() - existing.warmedAt
      if (ageMs < WARMUP_CACHE_TTL_MS) {
        log.info('warmup skipped: cache still fresh', {
          ageMs,
          cwd: args.cwd,
          model: args.model ?? 'default',
          effort: args.effort ?? 'default',
        })
        return existing.promise
      }
      log.info('warmup cache expired; starting a new request', { ageMs, cwd: args.cwd })
      this.warmups.delete(key)
    }

    const state: { promise: Promise<void>; warmedAt: number | null } = {
      promise: Promise.resolve(),
      warmedAt: null,
    }
    state.promise = this.runWarmup(args)
      .then(() => {
        state.warmedAt = Date.now()
      })
      .catch((error) => {
        this.warmups.delete(key)
        throw error
      })
    this.warmups.set(key, state)
    return state.promise
  }

  private async runWarmup(args: WarmupBackendArgs): Promise<void> {
    const sessionId = randomUUID()
    const startedAt = Date.now()
    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(), WARMUP_TIMEOUT_MS)
    const askUser = createAskUserServer((_requestId, _question) => {})
    log.info('warmup started', {
      sessionId,
      cwd: args.cwd,
      model: args.model ?? 'default',
      effort: args.effort ?? 'default',
      timeoutMs: WARMUP_TIMEOUT_MS,
    })

    // 与正式 turn 保持相同的 system prompt 和 MCP schema，才能复用共享前缀缓存。
    // Warmup 不允许执行任何工具；若模型意外请求工具，直接拒绝。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options: Record<string, any> = {
      abortController,
      allowDangerouslySkipPermissions: true,
      canUseTool: async () => ({
        behavior: 'deny',
        message: 'Warmup does not execute tools',
        interrupt: true,
      }),
      cwd: args.cwd,
      env: { ...process.env, ...this.extraEnv },
      includePartialMessages: false,
      mcpServers: {
        catmax: { type: 'sdk', name: 'catmax', instance: askUser.server },
      },
      permissionMode: 'default',
      sessionId,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: ASK_USER_GUIDE },
    }
    if (args.model) options.model = args.model
    if (args.effort) options.effort = args.effort === 'none' ? 'low' : args.effort
    const binaryPath = this.resolveSdkBinaryPath()
    if (binaryPath !== undefined) options.pathToClaudeCodeExecutable = binaryPath

    try {
      const sdkQuery = query({ prompt: WARMUP_PROMPT, options })
      for await (const message of sdkQuery) {
        if (isSdkResultMessage(message)) {
          const result = message as unknown as { subtype?: string; is_error?: boolean }
          log.info('warmup result received', {
            sessionId,
            subtype: result.subtype ?? 'unknown',
            isError: result.is_error ?? false,
          })
        }
        if (isSdkSystemMessage(message) && !this.modelsCache) {
          try {
            const init = await sdkQuery.initializationResult()
            if (init.models.length > 0) this.modelsCache = init.models
          } catch (error) {
            log.debug('warmup initializationResult failed:', error)
          }
        }
      }
      log.info('warmup completed', {
        sessionId,
        durationMs: Date.now() - startedAt,
        cwd: args.cwd,
        model: args.model ?? 'default',
      })
    } finally {
      clearTimeout(timeout)
      askUser.rejectAll()
      await askUser.server
        .close()
        .catch((error) => log.debug('warmup ask_user server close failed:', error))
      try {
        await deleteSdkSession(sessionId, { dir: args.cwd })
        log.info('warmup transcript deleted', { sessionId, cwd: args.cwd })
      } catch (error) {
        log.warn('warmup transcript cleanup failed:', { sessionId, cwd: args.cwd, error })
      }
    }
  }

  async listSessions(cwd?: string): Promise<SessionSummary[]> {
    return listClaudeSessionsFromDisk(cwd)
  }

  async deleteSession(backendThreadId: string, cwd?: string): Promise<void> {
    const spawnCwd = cwd ?? this.opts.cwd
    const jsonlPath = resolveSessionJsonlPath(backendThreadId, spawnCwd)
    try {
      await unlink(jsonlPath)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      log.warn('deleteSession: unlink failed', jsonlPath, e)
    }
  }

  async resumeSession(backendThreadId: string): Promise<{ messages: NormalizedMessage[] }> {
    void backendThreadId
    // resume 在下一个 startTurn 通过 options.resume 隐式发生
    return { messages: [] }
  }

  async getHistory(
    backendThreadId: string,
    cwd?: string,
  ): Promise<{ messages: NormalizedMessage[]; aiTitle?: string | null }> {
    const spawnCwd = cwd ?? this.opts.cwd
    const result = await readHistoryFromJsonl(backendThreadId, spawnCwd)
    if (result === null) {
      throw new BackendError(
        'protocol',
        `claude getHistory(${backendThreadId}, cwd=${spawnCwd ?? '<include>'}): session jsonl not found`,
      )
    }
    log.info(
      'history loaded from jsonl',
      backendThreadId,
      result.messages.length,
      'messages, title=',
      result.aiTitle,
    )
    return { messages: result.messages, aiTitle: result.aiTitle }
  }

  // ============ 核心：startTurn ============

  async *startTurn(args: StartTurnArgs): AsyncIterable<TurnEvent> {
    const internalTurnId = randomUUID()
    yield { type: 'turn_started', turnId: internalTurnId, sessionId: args.sessionId }

    // ---- 解析 claude session id + 决定能否 resume ----
    const claudeSessionId = this.sessionIdMap.get(args.sessionId) ?? args.sessionId
    let canResume = this.resumableSessions.has(args.sessionId)
    if (!canResume && args.cwd) {
      // 进程重启兜底：如果 jsonl 已存在，说明这个 id 就是真实 session id
      const jsonlPath = resolveSessionJsonlPath(args.sessionId, args.cwd)
      if (existsSync(jsonlPath)) {
        this.sessionIdMap.set(args.sessionId, args.sessionId)
        this.resumableSessions.add(args.sessionId)
        canResume = true
        log.info('resumable from disk (process restarted)', args.sessionId)
      }
    }

    // ---- 构建 SDK query options ----
    const spawnCwd = args.cwd ?? this.opts.cwd
    const abortController = new AbortController()
    const aggregator = new SdkPartialAggregator(internalTurnId)
    let sawStreamEvents = false

    // pendingApprovals：canUseTool 回调 await 这里的 promise，respondApproval resolve 它。
    // suggestions 存进来给 approve_always 回传（见 canUseTool 注释）。
    const pendingApprovals = new Map<
      string,
      {
        resolve: (action: ApprovalDecision['action']) => void
        suggestions?: PermissionUpdate[] | undefined
      }
    >()

    // 事件队列 + 唤醒机制：canUseTool 回调和 SDK 流都把事件推进来，generator 主循环消费。
    // resolveWait 用对象包装，避免 TS 在 async 闭包里对 let 变量的控制流 narrowing 问题。
    const queue: TurnEvent[] = []
    const waker = { resolve: null as (() => void) | null }
    const pushEvent = (event: TurnEvent): void => {
      queue.push(event)
      waker.resolve?.()
    }

    // canUseTool 回调：SDK 每次要执行工具前调用。
    // options 带 SDK 原生计算的友好文案（displayName/description/decisionReason/title）
    // 和 suggestions（approve_always 时作为 updatedPermissions 回传，让"本会话都允许"真生效）。
    const canUseTool: CanUseTool = async (toolName, input, options) => {
      // ask_user 工具白名单放行——它是 agent 问用户问题的通道，走自己的 QuestionPanel，
      // 不应触发权限面板（否则会弹错误的面板）。工具名可能是 ask_user 或 mcp__catmax__ask_user。
      if (toolName === 'ask_user' || toolName === 'mcp__catmax__ask_user') {
        return { behavior: 'allow', updatedInput: input } satisfies PermissionResult
      }
      const request = claudePermissionToApprovalRequest(toolName, input, {
        displayName: options.displayName,
        description: options.description,
        decisionReason: options.decisionReason,
        title: options.title,
      })
      const requestId = `${internalTurnId}:${randomUUID()}`

      const decisionAction = await new Promise<ApprovalDecision['action']>((resolve) => {
        pendingApprovals.set(requestId, { resolve, suggestions: options.suggestions })
        pushEvent({
          type: 'approval_requested',
          turnId: internalTurnId,
          requestId,
          request,
          source: 'claude',
        })
      })

      const pending = pendingApprovals.get(requestId)
      pendingApprovals.delete(requestId)

      if (decisionAction === 'reject') {
        return {
          behavior: 'deny',
          message: '用户拒绝',
          decisionClassification: 'user_reject',
        } satisfies PermissionResult
      }
      // approve_always + 有 suggestions → 放行 + 回传 updatedPermissions，持久化"本会话都允许"
      if (decisionAction === 'approve_always' && pending?.suggestions?.length) {
        return {
          behavior: 'allow',
          updatedInput: input,
          updatedPermissions: pending.suggestions,
          decisionClassification: 'user_permanent',
        } satisfies PermissionResult
      }
      // approve（或 approve_always 但无 suggestions 兜底）→ 放行，原样回传 input
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionClassification: 'user_temporary',
      } satisfies PermissionResult
    }

    // ---- ask_user MCP server：让 agent 能问用户问题（替代被 isInteractive 门控的内置 AskUserQuestion）----
    // onQuestion 回调把问题推成 agent_question 事件给 UI；handler 在 server 内部阻塞等 respondQuestion。
    const askUser = createAskUserServer((requestId, question) => {
      pushEvent({
        type: 'agent_question',
        turnId: internalTurnId,
        requestId,
        question,
      })
    })

    // ---- 组装 options ----
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options: Record<string, any> = {
      abortController,
      includePartialMessages: true, // 真正的 token 级流式（对应 CLI 的 --include-partial-messages）
      canUseTool, // 进程内权限回调，替代 CLI 的 --permission-prompt-tool + MCP + socket
      // ask_user 工具以 in-process MCP server 注入（type:'sdk'，SDK 自行接管 transport）
      mcpServers: {
        catmax: { type: 'sdk', name: 'catmax', instance: askUser.server },
      },
      // 追加 ask_user 引导语到 Claude Code 默认 system prompt（不覆盖默认 prompt）
      systemPrompt: { type: 'preset', preset: 'claude_code', append: ASK_USER_GUIDE },
    }
    if (spawnCwd !== undefined) options.cwd = spawnCwd
    if (canResume) options.resume = claudeSessionId
    if (args.model) options.model = args.model
    if (args.effort) {
      // effort='none'：SDK 同样没有真正的 off，映射到 low（与 CLI 时代一致）
      options.effort = args.effort === 'none' ? 'low' : args.effort
    }
    if (args.permissionMode) {
      options.permissionMode = args.permissionMode
    }
    // 始终授权 allowDangerouslySkipPermissions。
    // 这个 flag 本身不绕过权限——实际是否绕过由 permissionMode 控制。
    // 但它必须在启动时设，否则运行中热切换到 bypassPermissions 会被 claude
    // 拒绝（claude 的安全设计：bypass 是进程级授权，不能运行中从低权限提升）。
    // catmax 的权限控制由 canUseTool 回调 + permissionMode 共同保障，不依赖此 flag。
    options.allowDangerouslySkipPermissions = true
    // 注入子进程 env。
    // ⚠️ SDK 的 options.env 是【整体替换】语义（见 sdk.d.ts 示例 env:{...process.env,...}），
    // 必须先展开 process.env 再覆盖 extraEnv，否则子进程会丢失 PATH / HOME / SHELL 等
    // 基础变量 → claude 跑任何 Bash 命令都会 "command not found"（实测会话里 PATH= 为空）。
    options.env = { ...process.env, ...this.extraEnv }
    // binary 路径：packaged 模式指向 unpacked 真实路径；dev 让 SDK 自行 resolve
    const binaryPath = this.resolveSdkBinaryPath()
    if (binaryPath !== undefined) {
      options.pathToClaudeCodeExecutable = binaryPath
    }

    // ---- streaming-input：prompt 用 AsyncIterable<SDKUserMessage> ----
    // 必须用 streaming-input 模式才能调 Query 的 setModel/setPermissionMode/applyFlagSettings
    //（SDK 文档：control methods only available in streaming input mode）。
    // 输入源 yield 一条用户消息后保持开启，让 Query 活跃；turn 结束时 close()。
    let resolveInputWait: (() => void) | null = null
    let inputClosed = false
    const inputQueue: SDKUserMessage[] = []
    const inputController = {
      close: () => {
        inputClosed = true
        resolveInputWait?.()
      },
    }
    async function* inputStream(): AsyncIterable<SDKUserMessage> {
      // 第一条：用户本次的消息
      yield {
        type: 'user',
        message: { role: 'user', content: args.prompt },
        parent_tool_use_id: null,
      }
      // 保持开启，等 close 或后续 push（用于 steer 等场景）
      while (!inputClosed) {
        await new Promise<void>((resolve) => {
          resolveInputWait = resolve
        })
        resolveInputWait = null
        while (inputQueue.length > 0) {
          yield inputQueue.shift()!
        }
      }
    }

    // ---- 创建 query ----
    let sdkQuery: Query
    try {
      sdkQuery = query({ prompt: inputStream(), options })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.error('query() creation failed:', msg)
      inputController.close()
      yield {
        type: 'error',
        turnId: internalTurnId,
        message: `SDK query 启动失败: ${msg}`,
        recoverable: false,
      }
      yield { type: 'turn_completed', turnId: internalTurnId, status: 'error' }
      return
    }

    const ctx: TurnContext = {
      query: sdkQuery,
      abortController,
      pendingApprovals,
      interrupted: false,
      sessionId: args.sessionId,
      inputController,
      askUser: {
        respondQuestion: askUser.respondQuestion,
        rejectAll: askUser.rejectAll,
      },
    }
    this.turnContexts.set(internalTurnId, ctx)

    // ---- 后台异步消费 SDK 流，把事件推入 queue ----
    const streamDone = { value: false, error: null as Error | null }
    void (async () => {
      try {
        for await (const msg of sdkQuery) {
          const events = this.processSdkMessage(
            msg,
            internalTurnId,
            args.sessionId,
            aggregator,
            () => {
              sawStreamEvents = true
            },
            sawStreamEvents,
          )
          for (const ev of events) pushEvent(ev)
          if (events.some((e) => e.type === 'turn_completed')) break
        }
        // turn 正常结束后，缓存可用模型列表（initializationResult 复用首次连接结果，零额外开销）
        // 这样下次 listModels() 能返回真实列表而非静态 fallback。
        if (!this.modelsCache) {
          try {
            const init = await sdkQuery.initializationResult()
            if (init.models && init.models.length > 0) {
              this.modelsCache = init.models
              log.info('cached', init.models.length, 'models from initializationResult')
            }
          } catch (e) {
            log.debug('initializationResult for models cache failed:', e)
          }
        }
      } catch (e) {
        streamDone.error = e instanceof Error ? e : new Error(String(e))
        pushEvent({
          type: 'error',
          turnId: internalTurnId,
          message: streamDone.error.message,
          recoverable: false,
        })
        pushEvent({ type: 'turn_completed', turnId: internalTurnId, status: 'error' })
      } finally {
        streamDone.value = true
        waker.resolve?.()
      }
    })()

    // ---- generator 主循环：从 queue yield 事件 ----
    try {
      while (!streamDone.value || queue.length > 0) {
        while (queue.length > 0) {
          const event = queue.shift()!
          yield event
          if (event.type === 'turn_completed') return
        }
        // queue 空了但流还没结束，等待唤醒
        if (!streamDone.value) {
          await new Promise<void>((resolve) => {
            waker.resolve = resolve
          })
          waker.resolve = null
        }
      }
    } finally {
      // 关闭 streaming-input 迭代器，让 query 自然结束
      inputController.close()
      this.turnContexts.delete(internalTurnId)
      // 中断未决的权限审批，避免 promise 泄漏
      for (const [, pending] of pendingApprovals) pending.resolve('reject')
      pendingApprovals.clear()
      // 兜底：未回答的 ask_user 问题以空答案 resolve（让 handler 返回，避免阻塞）
      askUser.rejectAll()
      // 关闭 ask_user MCP server（释放资源）
      void askUser.server.close().catch((e) => log.debug('ask_user server close failed:', e))
      // 如果 generator 被提前 return/break（流还没结束），确保 abort
      if (!streamDone.value) {
        ctx.interrupted = true
        abortController.abort()
      }
    }
  }

  // ============ SDK 消息分发 ============

  /**
   * 处理一条 SDKMessage，返回要 emit 的 TurnEvent[]。
   * 对应 CLI 时代 adapter.ts 的 onChunk 分发逻辑。
   */
  private processSdkMessage(
    msg: SDKMessage,
    turnId: string,
    sessionId: string,
    aggregator: SdkPartialAggregator,
    markStreamed: () => void,
    sawStreamEvents: boolean,
  ): TurnEvent[] {
    const events: TurnEvent[] = []

    if (isSdkSystemMessage(msg)) {
      const sid = sdkSystemSessionId(msg)
      if (sid) {
        // 回填真实 session id + 触发 onRealSessionId（manager 用来回写 db）
        this.sessionIdMap.set(sessionId, sid)
        this.resumableSessions.add(sessionId)
        try {
          this.opts.onRealSessionId?.(sessionId, sid)
        } catch (e) {
          log.warn('onRealSessionId callback failed:', e)
        }
      }
      return events
    }

    if (isSdkPartialMessage(msg)) {
      markStreamed()
      const partialEvents = aggregator.push(msg)
      events.push(...partialEvents)
      return events
    }

    if (isSdkAssistantMessage(msg)) {
      // 完整 assistant 消息。如果已经走了 partial 路径，跳过（避免重复）。
      if (sawStreamEvents) return events
      for (const ev of sdkAssistantToEvents(msg, turnId)) {
        events.push(ev)
      }
      return events
    }

    if (isSdkUserMessage(msg)) {
      // tool_result → tool_call_completed
      events.push(...sdkUserToolResultToEvents(msg, turnId))
      return events
    }

    if (isSdkResultMessage(msg)) {
      // turn 结束。先 flush 兜底 tool_use，再推 turn_completed。
      if (sawStreamEvents) {
        events.push(...aggregator.flushPendingToolUse())
      }
      const resultEvent = sdkResultToEvent(msg, turnId)
      // result 是 error 时，先推 error 事件让 UI 显示可读错误（Bug D-2）
      if (resultEvent.type === 'turn_completed' && resultEvent.status === 'error') {
        events.push({
          type: 'error',
          turnId,
          message: `claude turn ended with error (subtype: ${msg.subtype})`,
          recoverable: false,
        })
      }
      events.push(resultEvent)
      return events
    }

    // 其他消息类型（status / api_retry / hook 等）暂不处理
    return events
  }

  /**
   * 运行中热切换 model/effort/permissionMode。
   *
   * 依赖 SDK streaming-input 模式下 Query 的 control 方法：
   * - model → setModel()：当前 turn 的下一次 model 调用起生效
   * - permissionMode → setPermissionMode()：立即生效
   * - effort → applyFlagSettings({ effortLevel })：下一 turn 生效
   *
   * 每项独立 try/catch，失败只 log warn 不抛（部分成功优于全失败）。
   */
  async updateTurnConfig(turnId: string, config: TurnConfigUpdate): Promise<void> {
    const ctx = this.turnContexts.get(turnId)
    if (!ctx) {
      log.debug('updateTurnConfig: no context for turn (already completed?)', turnId)
      return
    }

    if (config.model !== undefined) {
      try {
        await ctx.query.setModel(config.model)
        log.info('hot-swap model →', config.model)
      } catch (e) {
        log.warn('setModel hot-swap failed:', e)
      }
    }

    if (config.permissionMode !== undefined) {
      try {
        await ctx.query.setPermissionMode(config.permissionMode)
        log.info('hot-swap permissionMode →', config.permissionMode)
      } catch (e) {
        log.warn('setPermissionMode hot-swap failed:', e)
      }
    }

    if (config.effort !== undefined) {
      try {
        // effort='none'：SDK 没有真正的 off，映射到 low（与 query options 一致）
        const effortLevel = config.effort === 'none' ? 'low' : config.effort
        await ctx.query.applyFlagSettings({ effortLevel })
        log.info('hot-swap effort →', effortLevel, '(下一 turn 生效)')
      } catch (e) {
        log.warn('applyFlagSettings(effort) hot-swap failed:', e)
      }
    }
  }

  async interrupt(turnId: string): Promise<void> {
    const ctx = this.turnContexts.get(turnId)
    if (!ctx) {
      log.debug('interrupt: no context for turn (already completed?)', turnId)
      return
    }
    if (ctx.interrupted) return
    ctx.interrupted = true
    // SDK 的 interrupt 是协作式的——发中断信号让 query 流尽快结束。
    try {
      await ctx.query.interrupt()
    } catch (e) {
      log.warn('query.interrupt() failed, falling back to abort:', e)
      ctx.abortController.abort()
    }
  }

  async respondApproval(decision: ApprovalDecision): Promise<void> {
    const colonIdx = decision.requestId.lastIndexOf(':')
    if (colonIdx < 0) {
      log.warn('respondApproval: invalid requestId format', decision.requestId)
      return
    }
    const turnId = decision.requestId.slice(0, colonIdx)
    const ctx = this.turnContexts.get(turnId)
    if (!ctx) {
      log.warn('respondApproval: no context for turn', turnId)
      return
    }
    const pending = ctx.pendingApprovals.get(decision.requestId)
    if (!pending) {
      log.warn('respondApproval: no pending approval for', decision.requestId)
      return
    }
    ctx.pendingApprovals.delete(decision.requestId)
    pending.resolve(decision.action)
  }

  /**
   * 响应 agent 的问题（ask_user 工具）：把用户答案 resolve 给阻塞中的 handler，
   * handler 把它作为 tool_result 回流给模型。turnId 用来定位 turn context。
   */
  async respondQuestion(args: {
    turnId: string
    requestId: string
    answer: AgentAnswer
  }): Promise<void> {
    const ctx = this.turnContexts.get(args.turnId)
    if (!ctx) {
      log.warn('respondQuestion: no context for turn', args.turnId)
      return
    }
    ctx.askUser.respondQuestion(args.requestId, args.answer)
  }

  // ============ binary 路径解析（ASAR 打包支持） ============

  /**
   * 解析 SDK bundled binary 的磁盘路径。
   * - dev 模式：返回 undefined，让 SDK 通过 import.meta.url + createRequire 自行 resolve
   *   （PoC 验证：pnpm 的 .pnpm 结构能让 SDK 正确找到 binary）
   * - packaged 模式：返回 app.asar.unpacked 里的真实路径
   *   （PoC 验证：electron-builder 不会自动收集 optionalDependencies 的平台包，
   *    必须配 asarUnpack，再显式传 pathToClaudeCodeExecutable 绕过 resolve 链）
   */
  private resolveSdkBinaryPath(): string | undefined {
    if (!app.isPackaged) return undefined

    const platform = `${process.platform}-${process.arch}`
    // electron-builder 把 asarUnpack 的文件放到 app.asar.unpacked/
    const candidate = join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      `@anthropic-ai/claude-agent-sdk-${platform}`,
      'claude',
    )
    if (existsSync(candidate)) return candidate
    log.warn(
      'packaged mode but SDK binary not found at expected unpacked path; SDK resolve may fail:',
      candidate,
    )
    return undefined
  }
}
