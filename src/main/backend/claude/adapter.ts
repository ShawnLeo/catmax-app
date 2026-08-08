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
  forkSession as forkSdkSession,
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
import type { SlashCommandInfo } from '@shared/backend/slash-commands'
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
import type { McpRuntimeStatus } from '@shared/mcp/types'
import { app } from 'electron'

import { fetchUpstreamModels } from '../../protocol/upstream-models'
import {
  claudeOverrideSettingsPath,
  readClaudeOverrideSettings,
} from '../../service/backend-config-files'
import { logger } from '../../service/logger'
import { claudeMcpInjectServers } from '../../service/mcp-inject'
import { disabledSkillOverrides, mergeSkillOverrides } from '../../service/skill-state'
import { allSettled, mapClaudeMcpStatus } from '../shared/mcp-runtime-mapping'
import { buildWorkspaceInstructions, secondaryWorkspacePaths } from '../workspace-context'

import { createAskUserServer } from './ask-user-server'
import { ClaudeBackgroundTaskState } from './background-task-state'
import {
  listClaudeSessionsFromDisk,
  readHistoryFromJsonl,
  resolveSessionJsonlPath,
} from './jsonl-reader'
import { claudePermissionToApprovalRequest } from './mapping'
import {
  SdkPartialAggregator,
  isSdkAssistantMessage,
  isSdkInitMessage,
  isSdkPartialMessage,
  isSdkResultMessage,
  isSdkUserMessage,
  sdkAssistantToEvents,
  sdkResultToEvent,
  sdkSubagentToEvents,
  sdkSystemSessionId,
  sdkUserToolResultToEvents,
} from './sdk-mapping'
import { normalizeSlashCommands, type RawSlashCommand } from './slash-commands'
import { WARMUP_PROMPT } from './warmup-transcript'

const log = logger.domain('claude-adapter')
const WARMUP_CACHE_TTL_MS = 4 * 60 * 1000
const WARMUP_TIMEOUT_MS = 30_000
/** dispose 等预热清理 transcript 的上限——退出路径，不能无限等（见 dispose） */
const WARMUP_DISPOSE_GRACE_MS = 3_000
/**
 * 专门拉命令表时的握手超时。
 *
 * 实测冷启握手 2.1–2.6 秒，给到 15 秒是留足机器慢/首次解包的余量；拿不到就退回
 * 静态兜底表，不值得让用户对着弹层干等。
 */
const SLASH_COMMANDS_TIMEOUT_MS = 15_000

/**
 * 拉 MCP 运行时状态的总预算。
 *
 * 握手实测 3.2 秒，最后一个 server 落定在 t+9.2 秒。20 秒是给慢机器和多 server
 * 留的余量；到点就把已拿到的部分交出去，没落定的显示成「连接中」。
 */
const MCP_RUNTIME_TIMEOUT_MS = 20_000
/** 轮询间隔。实测状态大约每 2 秒变一次，再密就是白问。 */
const MCP_RUNTIME_POLL_MS = 1_000

/**
 * "result 到了但 turn 被后台任务留着"之后，等待后续事件的上限。
 *
 * 有后台任务时首个 result 只是模型回合边界，turn 要等任务汇总回合才收尾（见
 * ClaudeBackgroundTaskState.classifyResult）。但这条路径一旦等不到该来的通知，
 * turn 就没有任何自愈手段——只剩协调器 30 分钟的 idle 看门狗，用户看到的是模型
 * 明明已经把话说完，UI 还在转"正在思考"。60 秒足够正常的汇总回合跑完，又不至于
 * 让人干等；到点强制收尾，仍在 running 的任务一并标成 stopped。
 */
const TURN_HOLD_TIMEOUT_MS = 60_000

/**
 * interrupt 里单个 SDK control request 的上限。
 *
 * stopTask()/interrupt() 都要往 SDK 子进程发一次 control request 并等回执。子进程
 * 卡住时这两个 await 永远不 resolve，abort 兜底又写在 catch 里够不着，UI 只能干等
 * 协调器 15 秒的 cancel grace。超时就直接 abort，让停止按钮秒级生效。
 */
const INTERRUPT_CONTROL_TIMEOUT_MS = 3_000

/**
 * Upstream 模型探测成功后的复用窗口——同一份上游目录没必要每次 listModels() 都重新打一次。
 */
const UPSTREAM_MODELS_CACHE_TTL_MS = 5 * 60 * 1000
/**
 * 没配自定义上游 / 探测失败时的重试窗口。比成功缓存短很多：一次性网络抖动不该让用户
 * 卡在旧结果上太久；但也不能每次 listModels() 调用都重新打一个当下不可达的地址。
 * "刷新模型"按钮走 invalidateModelsCache()，不受这个窗口限制。
 */
const UPSTREAM_MODELS_RETRY_TTL_MS = 60 * 1000

/** 官方端点没必要探测——SDK 静态目录本来就是它的真实目录，还比 /v1/models 多带 effort/thinking 元数据。 */
function isOfficialAnthropicHost(url: string): boolean {
  try {
    return new URL(url).hostname === 'api.anthropic.com'
  } catch {
    return false
  }
}

/** 覆盖配置档的 env 块类型不受信（JSON.parse 出来是 unknown），这里窄化并只留字符串值。 */
function asEnvRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {}
  const result: Record<string, string> = {}
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') result[key] = v
  }
  return result
}

/** 给 promise 加超时；超时抛错而不是静默 resolve，调用方才能走兜底分支。 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

type TurnCompletedEvent = Extract<TurnEvent, { type: 'turn_completed' }>

/**
 * Steer Continuation: 从一批事件里摘出可以被 steer 扣住的终态，摘不到返回 null。
 *
 * 只认 `completed`：`error` / `interrupted` 说明这一轮已经不正常结束，排队的 steer
 * 消息未必还会被 SDK 处理，继续扣着终态只会让 turn 悬在 running。
 * 摘除是就地 splice——同一批里的其他事件（flushPendingToolUse 的补发等）要照常发出去。
 */
function takeSuppressibleTerminal(events: TurnEvent[]): TurnCompletedEvent | null {
  const index = events.findIndex((e) => e.type === 'turn_completed' && e.status === 'completed')
  if (index < 0) return null
  return (events.splice(index, 1)[0] as TurnCompletedEvent) ?? null
}

/**
 * 一条永远不产出消息的 prompt 流。
 *
 * 取斜杠命令表只需要握手——命令表在 initialize 的响应里，发任何消息都是白花 token。
 * 但 query() 必须给 prompt，给一个空数组它会立刻结束、`initializationResult()` 就
 * 拿不到了。所以给一条永远 pending 的流，靠调用方的 abortController 收尾。
 */
function neverEndingPrompt(): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
  }
}

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
  /** Claude 后台 Agent 的 turn 级生命周期状态机。 */
  backgroundTasks: ClaudeBackgroundTaskState
  /** AbortController，用于 dispose 时强制中断 */
  abortController: AbortController
  /** interrupt 也需要向当前 turn 的事件队列推送本地 stopped 快照。 */
  pushEvent: (event: TurnEvent) => void
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
  inputController: {
    close: () => void
    push: (prompt: string) => boolean
  }
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
   * Upstream 模型探测结果缓存——跟 modelsCache（SDK 静态目录）是两条独立路径。
   * undefined = 还没探测过；null = 探测过但没有自定义上游 / 探测失败 / 返回空列表；
   * 非空数组 = 探测到的真实模型列表，listModels() 会优先用它整个顶替 modelsCache。
   */
  private upstreamModelsCache: ModelOption[] | null | undefined
  private upstreamModelsCachedAt = 0
  /** 探测请求去重——并发调用 listModels() 只应该触发一次真实的网络请求。 */
  private upstreamModelsProbePromise: Promise<ModelOption[] | null> | null = null
  /**
   * Prompt-cache 预热按 cwd/model/effort 去重。这里缓存的是临时 Warmup turn，
   * 与任何 Catmax 用户会话无关；完成后对应的 Claude JSONL 会被删除。
   */
  private warmups = new Map<string, { promise: Promise<void>; warmedAt: number | null }>()
  /**
   * Warmup Transcript: 当前在跑的预热——dispose 时要中断它们，并等它们把自己的
   * transcript 删干净。不这么做的话，退出时正在预热就会在磁盘上留下一份
   * "Session warmup"，下次启动被扫进侧边栏。
   *
   * 与上面的 warmups 是两回事：那个按 cwd/model/effort 做 TTL 去重（完成后还留着
   * 用于判断缓存是否新鲜），这个只装"此刻还没跑完的"，结束即移除。
   */
  private inFlightWarmups = new Map<string, { abort: AbortController; done: Promise<void> }>()
  /**
   * 斜杠命令表缓存，**按 cwd 分**。
   *
   * 跟 modelsCache 的单例形成对比，这个差异很容易踩：模型列表跟 cwd 无关，
   * 但命令表包含项目 Skill（<cwd>/.claude/skills/），换个目录内容就变了。
   * 本机实测 cwd=catmax-app 时 79 条、cwd=~ 时 78 条，差的就是 catmax-conventions。
   */
  private slashCommandsCache = new Map<string, SlashCommandInfo[]>()
  /**
   * 正在拉取的命令表，按 cwd 去重。
   *
   * 冷启一次握手实测 2.1–2.6 秒，且要 spawn 一个 claude 进程。打开工作区时预取和
   * 用户敲下 `/` 时的按需拉取会撞在一起，不去重就是两个进程做同一件事。
   */
  private slashCommandsInFlight = new Map<string, Promise<SlashCommandInfo[]>>()

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

    // Warmup Transcript: 中断在跑的预热，并等它们把自己的 transcript 删掉——
    // 只 abort 不等的话，调用方（before-quit）紧接着就 app.exit(0)，
    // runWarmup 的 finally 根本来不及执行，磁盘上照样留下一份残留。
    const warmups = [...this.inFlightWarmups.values()]
    if (warmups.length > 0) {
      for (const w of warmups) w.abort.abort()
      // 超时兜底：这是退出路径，卡在这里就是 app 关不掉。
      // 真超时了也没关系——启动清理会收掉那份残留。
      await Promise.race([
        Promise.all(warmups.map((w) => w.done)),
        new Promise((resolve) => setTimeout(resolve, WARMUP_DISPOSE_GRACE_MS)),
      ])
      log.info('dispose: aborted', warmups.length, 'in-flight warmup(s)')
    }
  }

  getCapabilities(): BackendCapabilities {
    return this.capabilities
  }

  async listModels(): Promise<ModelOption[]> {
    // 自定义上游：先探测 /v1/models，探测不到再退到 ANTHROPIC_DEFAULT_*_MODEL 配置——
    // 两层逻辑都在 probeUpstreamModels() 里，见其注释。
    const upstream = await this.getUpstreamModels()
    if (upstream && upstream.length > 0) return upstream

    // 没配自定义上游 / 两层都拿不到：退回 SDK 目录，这条路径本身也用 resolvedModel
    // 做过修正，见 mapModelInfo 注释。
    // 有动态缓存（首次 query 后从 SDK initializationResult 拿到）→ 返回真实列表
    if (this.modelsCache && this.modelsCache.length > 0) {
      return this.modelsCache.map((m) => this.mapModelInfo(m))
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
    this.upstreamModelsCache = undefined
    this.upstreamModelsCachedAt = 0
    // 顺带丢弃可能还在飞的探测 promise——不这么做的话，紧跟着 invalidate 之后的
    // listModels() 会直接复用那个用旧 target 发起的 in-flight 请求，等于白 invalidate。
    this.upstreamModelsProbePromise = null
  }

  /**
   * Upstream 模型探测的查询套件：TTL 缓存 + 并发去重。
   *
   * 返回 null 统一表示"这次不该用探测结果"——不管背后原因是没配自定义上游、探测失败
   * 还是返回了空列表，调用方（listModels）都只需要退回 SDK 静态目录，不用关心细节。
   */
  private async getUpstreamModels(): Promise<ModelOption[] | null> {
    if (this.upstreamModelsCache !== undefined) {
      const ttl =
        this.upstreamModelsCache && this.upstreamModelsCache.length > 0
          ? UPSTREAM_MODELS_CACHE_TTL_MS
          : UPSTREAM_MODELS_RETRY_TTL_MS
      if (Date.now() - this.upstreamModelsCachedAt < ttl) {
        return this.upstreamModelsCache
      }
    }

    if (!this.upstreamModelsProbePromise) {
      this.upstreamModelsProbePromise = this.probeUpstreamModels()
        .then((result) => {
          this.upstreamModelsCache = result
          this.upstreamModelsCachedAt = Date.now()
          return result
        })
        .finally(() => {
          this.upstreamModelsProbePromise = null
        })
    }
    return this.upstreamModelsProbePromise
  }

  /**
   * 自定义上游的真实模型列表——三层兜底，前一层拿不到才落到下一层：
   *
   * 1. 主动探测 `/v1/models`（复用协议桥已有的 fetchUpstreamModels）。中转确实实现了
   *    这个接口时最准——能看到 alias 机制之外的完整目录，不局限于 opus/sonnet/haiku。
   * 2. 探测失败/为空时，直接读覆盖配置里的 `ANTHROPIC_DEFAULT_OPUS_MODEL` /
   *    `_SONNET_MODEL` / `_HAIKU_MODEL`——这是 Claude Code 官方给第三方中转设计的别名
   *    重映射机制（本仓库自己的 CLAUDE_INTERNAL_DEFAULT_OVERRIDE 模板就是这么配的），
   *    纯读配置文件，不发任何网络请求。**中转没有 /models 接口是常态，不是异常**——
   *    很多厂商 / 用户自建中转根本没实现它，这里静默接力，不算故障。
   * 3. 两者都没有 → 返回 null，调用方（listModels）退回 mapModelInfo() 处理过的
   *    modelsCache（SDK 自己握手后给出的目录，其中 resolvedModel 字段也是同一套
   *    ANTHROPIC_DEFAULT_*_MODEL 解析结果，只是要等 warmup/turn 跑过一次才有值），
   *    再不行才是硬编码的 sonnet/opus/haiku 静态兜底。
   *
   * 每一层返回项的 id 都是真实模型 id，直接经 `options.model = args.model` 发给
   * SDK——不经过任何别名或展示层转换，跟实际发起请求时用的字符串完全一致。
   *
   * 没配自定义上游（`resolveUpstreamProbeTarget` 返回 null）时整个方法直接返回 null。
   */
  private async probeUpstreamModels(): Promise<ModelOption[] | null> {
    const target = this.resolveUpstreamProbeTarget()
    if (!target) return null

    try {
      const models = await fetchUpstreamModels({
        modelsUrl: '',
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
      })
      if (models.length > 0) {
        log.info('probed upstream models via /models', {
          baseUrl: target.baseUrl,
          count: models.length,
        })
        return models.map((m) => ({ id: m.id, displayName: m.displayName }))
      }
    } catch (error) {
      log.debug('probe /models failed, falling back to ANTHROPIC_DEFAULT_*_MODEL env', error)
    }

    const derived = this.deriveModelsFromAliasEnv()
    if (derived) {
      log.info('derived models from ANTHROPIC_DEFAULT_*_MODEL env', {
        baseUrl: target.baseUrl,
        count: derived.length,
      })
    }
    return derived
  }

  /**
   * 从 `ANTHROPIC_DEFAULT_OPUS_MODEL` / `_SONNET_MODEL` / `_HAIKU_MODEL` 直接拼出模型列表。
   *
   * 这三个 key 跟 mapModelInfo() 里读的 `ModelInfo.resolvedModel` 是同一份底层数据的
   * 两种取法：resolvedModel 要等 SDK 握手过一次才有（modelsCache 得等 warmup/turn 跑过
   * 一次），这里是不等握手、直接读配置文件——所以能放在探测失败之后立刻用，用户第一次
   * 打开 Composer / 设置页、还没发过一条消息时也能看到真实模型，不用先等一次预热。
   *
   * displayName 直接用真实模型 id 本身，不再套 "Opus/Sonnet (glm-5.2)" 这种别名前缀——
   * 用户配的是中转自己的模型，下拉框里就该直接看到那个模型叫什么，不用先在脑子里翻译
   * 一遍"这个 Opus 到底对应哪个模型"。
   *
   * 同一个 id 出现在多个别名下时只保留一条（本仓库自己的内测中转就是 OPUS 和 SONNET
   * 都指向 glm-5.2），避免下拉框里出现两条 id 完全相同的选项。
   *
   * 三个 key 都没配就返回 null，交给调用方继续往下一层兜底。
   */
  private deriveModelsFromAliasEnv(): ModelOption[] | null {
    const env = this.effectiveEnv()
    const envKeys = [
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    ]

    const seen = new Set<string>()
    const models: ModelOption[] = []
    for (const envKey of envKeys) {
      const id = (env[envKey] ?? '').trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      models.push({ id, displayName: id })
    }
    return models.length > 0 ? models : null
  }

  /**
   * 当前生效的 env——探测目标解析和别名兜底解析共享同一份优先级规则。
   *
   * 读取优先级（同一个 key 后面覆盖前面）：process.env → extraEnv（代理设置注入）→
   * 覆盖配置档的 env 块。覆盖档是 SDK 的 "flag settings" 层，本来就该盖过前两者——
   * 跟 applyOverrideSettings() 把它交给 SDK 时的优先级保持一致，不能反过来。
   */
  private effectiveEnv(): Record<string, string | undefined> {
    const overridePath = claudeOverrideSettingsPath()
    const overrideEnv = overridePath
      ? asEnvRecord(readClaudeOverrideSettings(overridePath).env)
      : {}
    return { ...process.env, ...this.extraEnv, ...overrideEnv }
  }

  /** 探测目标——只在配置了非官方 ANTHROPIC_BASE_URL 时才有意义。 */
  private resolveUpstreamProbeTarget(): { baseUrl: string; apiKey: string } | null {
    const env = this.effectiveEnv()
    const baseUrl = (env.ANTHROPIC_BASE_URL ?? '').trim()
    if (!baseUrl || isOfficialAnthropicHost(baseUrl)) return null

    const apiKey = (env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? '').trim()
    return { baseUrl, apiKey }
  }

  /**
   * 列出该 cwd 下可用的斜杠命令（含项目/用户 Skill）。
   *
   * 缓存命中就同步返回；没命中要冷启一次握手（实测 2.1–2.6 秒），所以调用方
   * 应该在打开工作区时就提前调一次，别等用户敲下 `/`。拉失败返回空数组——
   * renderer 侧会退回静态兜底表，用户不会看到空弹层。
   */
  async listSlashCommands(cwd: string): Promise<SlashCommandInfo[]> {
    const cached = this.slashCommandsCache.get(cwd)
    if (cached) return cached

    const inFlight = this.slashCommandsInFlight.get(cwd)
    if (inFlight) return inFlight

    const promise = this.fetchSlashCommands(cwd).finally(() => {
      this.slashCommandsInFlight.delete(cwd)
    })
    this.slashCommandsInFlight.set(cwd, promise)
    return promise
  }

  /**
   * 把一次已有连接的 initializationResult 顺手存进缓存。
   *
   * warmup 和正式 turn 结束时都会调 initializationResult() 拿模型列表，命令表就在
   * 同一个响应里——在那两处捎带一下是零额外开销，能让大部分情况根本走不到上面
   * 那条要花 2 秒的冷启路径。
   */
  private cacheSlashCommandsFrom(cwd: string, commands: RawSlashCommand[] | undefined): void {
    if (!commands || commands.length === 0) return
    if (this.slashCommandsCache.has(cwd)) return
    const normalized = normalizeSlashCommands(commands)
    this.slashCommandsCache.set(cwd, normalized)
    log.info('cached', normalized.length, 'slash commands for', cwd)
  }

  /** 专门为取命令表建一次连接：不发任何 prompt，握完手就中断。 */
  private async fetchSlashCommands(cwd: string): Promise<SlashCommandInfo[]> {
    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(), SLASH_COMMANDS_TIMEOUT_MS)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options: Record<string, any> = {
        abortController,
        cwd,
        env: { ...process.env, ...this.extraEnv },
        permissionMode: 'default',
      }
      this.applyOverrideSettings(options)
      const binaryPath = this.resolveSdkBinaryPath()
      if (binaryPath !== undefined) options.pathToClaudeCodeExecutable = binaryPath

      const sdkQuery = query({ prompt: neverEndingPrompt(), options })
      const init = await sdkQuery.initializationResult()
      const normalized = normalizeSlashCommands(
        (init.commands ?? []) as unknown as RawSlashCommand[],
      )
      this.slashCommandsCache.set(cwd, normalized)
      log.info('fetched', normalized.length, 'slash commands for', cwd)
      return normalized
    } catch (error) {
      log.debug('listSlashCommands failed for', cwd, error)
      return []
    } finally {
      clearTimeout(timeout)
      abortController.abort()
    }
  }

  /**
   * Unified MCP Server Center: 读 claude 侧 MCP server 的连接情况。
   *
   * ⚠️ 这里必须**轮询**，一次读到的永远是 pending。实测（本机 3 个 server）：
   * `initializationResult()` 返回时（t+3.2s）三个全是 pending；t+5.2s 一个转 failed；
   * t+9.2s 两个转 connected（29 / 1 个工具）。claude 的 MCP 连接是握手之后才异步建立的，
   * 「握完手读一次」正是设计文档原本写的做法，实测证伪。
   *
   * 代价：一次冷启握手（约 3 秒）+ 最多 MCP_RUNTIME_TIMEOUT_MS 的等待，**零 token**
   * （用 neverEndingPrompt，跟拉斜杠命令表同一套）。所以只能由用户显式动作触发。
   *
   * 按 cwd：项目级 server 和 `projects.<abs>.disabledMcpServers` 都是 per-project 的，
   * 换个目录结果就不一样。
   */
  async listMcpRuntime(cwd?: string): Promise<McpRuntimeStatus[]> {
    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(), MCP_RUNTIME_TIMEOUT_MS)
    const deadline = Date.now() + MCP_RUNTIME_TIMEOUT_MS
    let latest: McpRuntimeStatus[] = []
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options: Record<string, any> = {
        abortController,
        cwd: cwd ?? process.cwd(),
        env: { ...process.env, ...this.extraEnv },
        permissionMode: 'default',
      }
      this.applyOverrideSettings(options)
      const binaryPath = this.resolveSdkBinaryPath()
      if (binaryPath !== undefined) options.pathToClaudeCodeExecutable = binaryPath

      const sdkQuery = query({ prompt: neverEndingPrompt(), options })
      await sdkQuery.initializationResult()

      while (Date.now() < deadline) {
        const raw = await sdkQuery.mcpServerStatus()
        latest = raw.map(mapClaudeMcpStatus).filter((s): s is McpRuntimeStatus => s !== null)
        // 全部落定就别再等了——常见情况下这能把 15 秒压到 6 秒左右。
        if (allSettled(latest)) break
        await new Promise((resolve) => setTimeout(resolve, MCP_RUNTIME_POLL_MS))
      }
      return latest
    } catch (error) {
      log.debug('listMcpRuntime failed for', cwd, error)
      // 超时/中断时把已经拿到的那部分交出去：三个里有两个已经落定的话，
      // 显示两个真状态 + 一个"连接中"，比整片空白有用得多。
      return latest
    } finally {
      clearTimeout(timeout)
      abortController.abort()
    }
  }

  /** SDK 的 effort 等级 → catmax 的 EffortLevel（补 'none'） */
  private mapEffortLevels(levels: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[]): EffortLevel[] {
    return ['none', ...levels]
  }

  /**
   * SDK 的 ModelInfo → catmax 的 ModelOption。
   *
   * 关键在 `resolvedModel`：官方场景下它就等于 `value`（'sonnet' → 'sonnet'），但配了
   * `ANTHROPIC_DEFAULT_SONNET_MODEL`/`_OPUS_MODEL`/`_HAIKU_MODEL`（或 SDK 的
   * `ANTHROPIC_CUSTOM_MODEL_OPTION` 自定义模型机制）这类第三方中转覆盖时，SDK 自己已经
   * 把别名解析成了真实 wire model id 并通过这个字段暴露出来（实测：设置
   * ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.2 后，'sonnet' 条目的 resolvedModel 就是
   * 'glm-5.2'）。
   *
   * 用它做 id 而不是 `value`：这样用户在下拉框里选中的字符串，就是之后
   * startTurnRequest/runWarmup 里 `options.model = args.model` 真正发给 SDK 的那个
   * 字符串——不用假手 'sonnet' 这层看不见的别名转换（也实测过直接传 resolvedModel
   * 握手正常，SDK 把它当显式 model id 处理，不会再走一遍别名解析）。displayName 也
   * 直接换成真实 id 本身，不拼 "Sonnet (glm-5.2)" 这种别名前缀——配的是中转自己的
   * 模型，下拉框里就该直接显示那个模型叫什么。
   */
  private mapModelInfo(m: ModelInfo): ModelOption {
    const resolved = m.resolvedModel && m.resolvedModel !== m.value ? m.resolvedModel : null
    return {
      id: resolved ?? m.value,
      displayName: resolved ?? m.displayName,
      ...(m.description ? { description: m.description } : {}),
      ...(m.supportedEffortLevels
        ? { supportedEfforts: this.mapEffortLevels(m.supportedEffortLevels) }
        : {}),
    }
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
    // Warmup Transcript: 登记到 inFlightWarmups，让 dispose 能中断并等它清理完。
    // done 是手动 resolve 的——函数拿不到自己返回的那个 promise。
    let markDone: () => void = () => {}
    const done = new Promise<void>((resolve) => {
      markDone = resolve
    })
    this.inFlightWarmups.set(sessionId, { abort: abortController, done })
    log.info('warmup started', {
      sessionId,
      cwd: args.cwd,
      model: args.model ?? 'default',
      effort: args.effort ?? 'default',
      timeoutMs: WARMUP_TIMEOUT_MS,
    })

    // 与正式 turn 保持相同的 system prompt 和 MCP schema，才能复用共享前缀缓存。
    // Warmup 不允许执行任何工具；若模型意外请求工具，直接拒绝。
    const workspaceInstructions = buildWorkspaceInstructions(args.workspaceFolders)
    const additionalDirectories = secondaryWorkspacePaths(args.workspaceFolders)
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
        // Unified MCP Server Center: 「补给 claude」的 server 走这里（注入层），
        // 不写用户配置。放在 catmax 之后，同名时 ask_user 优先——那是 catmax 自己的
        // 内部工具，被一个用户 server 顶掉会让追问功能直接失效。
        ...claudeMcpInjectServers(args.workspaceFolders?.map((f) => f.path) ?? []),
        catmax: { type: 'sdk', name: 'catmax', instance: askUser.server },
      },
      permissionMode: 'default',
      sessionId,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: workspaceInstructions
          ? `${ASK_USER_GUIDE}\n\n${workspaceInstructions}`
          : ASK_USER_GUIDE,
      },
    }
    if (additionalDirectories.length > 0) options.additionalDirectories = additionalDirectories
    if (args.model) options.model = args.model
    if (args.effort) options.effort = args.effort === 'none' ? 'low' : args.effort
    this.applyOverrideSettings(options)
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
        if (
          isSdkInitMessage(message) &&
          (!this.modelsCache || !this.slashCommandsCache.has(args.cwd))
        ) {
          try {
            const init = await sdkQuery.initializationResult()
            if (init.models.length > 0) this.modelsCache = init.models
            // 命令表跟模型在同一个响应里，捎带存下来——省掉后面一次 2 秒的冷启。
            this.cacheSlashCommandsFrom(
              args.cwd,
              init.commands as unknown as RawSlashCommand[] | undefined,
            )
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
      // 放在最后：dispose 等的就是"transcript 已经删完"这个时刻
      this.inFlightWarmups.delete(sessionId)
      markDone()
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

  /**
   * Session Fork: 复制会话——直接用 SDK 的 forkSession。
   *
   * 不能自己 cp 那个 .jsonl：transcript 每行都带 uuid / parentUuid 构成一条链，
   * 原样复制会让两个会话共用同一批 uuid，claude 侧 resume 时会串。SDK 的实现会
   * 重映射整条链，所以走它。
   *
   * dir 必须传 cwd——claude 按 cwd 编码分目录存 transcript，不传会去 main 进程的
   * cwd（catmax-app 自己的根目录）里找，直接 not found（同 getHistory 的坑）。
   */
  async forkSession(backendThreadId: string, cwd?: string): Promise<{ backendThreadId: string }> {
    const spawnCwd = cwd ?? this.opts.cwd
    const options: Parameters<typeof forkSdkSession>[1] = {}
    if (spawnCwd !== undefined) options.dir = spawnCwd
    const { sessionId } = await forkSdkSession(backendThreadId, options)
    // fork 出的 id 立刻标记为可 resume——它的 transcript 已经在磁盘上了。
    // 不标也能自愈（startTurn 会 existsSync 探测），标了省一次系统调用。
    this.sessionIdMap.set(sessionId, sessionId)
    this.resumableSessions.add(sessionId)
    log.info('forked session', backendThreadId, '->', sessionId)
    return { backendThreadId: sessionId }
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

    /*
     * claude 没有命令 turn——它的斜杠命令是**文本**，CLI 收到 user message 时自己
     * 拦截 `/xxx`，所以走普通 prompt 就行（TurnCommand 的注释里有两边的对比）。
     * 不认识就报错而不是把 prompt 照发：照发的话调用方以为命令生效了，实际发出去的
     * 是一句普通消息，排查时看到的现象是"命令时灵时不灵"。
     */
    if (args.command) {
      yield {
        type: 'error',
        turnId: internalTurnId,
        message: `claude 不支持命令 turn：${args.command.kind}`,
        recoverable: false,
      }
      yield { type: 'turn_completed', turnId: internalTurnId, status: 'error' }
      return
    }

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
    const backgroundTasks = new ClaudeBackgroundTaskState()
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
    const workspaceInstructions = buildWorkspaceInstructions(args.workspaceFolders)
    const additionalDirectories = secondaryWorkspacePaths(args.workspaceFolders)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options: Record<string, any> = {
      abortController,
      includePartialMessages: true, // 真正的 token 级流式（对应 CLI 的 --include-partial-messages）
      // 转发子 Agent 的文本/思考块（都带 parent_tool_use_id）。默认只转发它的
      // tool_use/tool_result，够做心跳计数但渲染不出过程——子 Agent 跑几分钟，
      // 用户只能看到工具次数在涨。开了才能把子 Agent 过程实时渲染出来。
      forwardSubagentText: true,
      canUseTool, // 进程内权限回调，替代 CLI 的 --permission-prompt-tool + MCP + socket
      // ask_user 工具以 in-process MCP server 注入（type:'sdk'，SDK 自行接管 transport）
      mcpServers: {
        // Unified MCP Server Center: 「补给 claude」的 server 走这里（注入层），
        // 不写用户配置。放在 catmax 之后，同名时 ask_user 优先——那是 catmax 自己的
        // 内部工具，被一个用户 server 顶掉会让追问功能直接失效。
        ...claudeMcpInjectServers(args.workspaceFolders?.map((f) => f.path) ?? []),
        catmax: { type: 'sdk', name: 'catmax', instance: askUser.server },
      },
      // 追加 ask_user 引导语到 Claude Code 默认 system prompt（不覆盖默认 prompt）
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: workspaceInstructions
          ? `${ASK_USER_GUIDE}\n\n${workspaceInstructions}`
          : ASK_USER_GUIDE,
      },
    }
    if (spawnCwd !== undefined) options.cwd = spawnCwd
    if (additionalDirectories.length > 0) options.additionalDirectories = additionalDirectories
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
    // catmax 覆盖配置（存在才注入；缺省的 key 由 SDK 回落到用户本地 settings）
    this.applyOverrideSettings(options)
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
    /**
     * Steer Continuation: 已 push 进输入流、但还没跑出自己那个 result 的 steer 消息数。
     *
     * SDK 不会把运行中收到的新 user message 并进当前回合，而是排队（transcript 里那条
     * `queue-operation: enqueue`），等当前回合的 result 之后 dequeue，再当成**新的一轮**
     * 跑完并给出**第二个 result**。catmax 一个 turn 必须一路覆盖到最后一个 result：
     * 否则第一个 result 就把 turn 收了，被 steer 追加的那一轮所有输出都落在
     * terminalQueued 之后（协调器同样在 turn_completed 后丢弃一切事件），
     * 用户看到的就是"补充的消息发出去了，页面上毫无反应"。
     */
    let pendingSteers = 0
    const inputController = {
      close: () => {
        inputClosed = true
        resolveInputWait?.()
      },
      push: (prompt: string): boolean => {
        if (inputClosed) return false
        inputQueue.push({
          type: 'user',
          message: { role: 'user', content: prompt },
          parent_tool_use_id: null,
          origin: { kind: 'human' },
        })
        pendingSteers += 1
        resolveInputWait?.()
        return true
      },
    }
    async function* inputStream(): AsyncIterable<SDKUserMessage> {
      // 第一条：用户本次的消息
      yield {
        type: 'user',
        message: { role: 'user', content: args.prompt },
        parent_tool_use_id: null,
        origin: { kind: 'human' },
      }
      // 保持开启，等 close 或后续 push（用于 steer 等场景）
      while (!inputClosed) {
        while (inputQueue.length > 0) {
          yield inputQueue.shift()!
        }
        if (inputClosed) break
        await new Promise<void>((resolve) => {
          resolveInputWait = resolve
        })
        resolveInputWait = null
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
      backgroundTasks,
      abortController,
      pushEvent,
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
      let terminalQueued = false
      /**
       * Steer Continuation: 最近一次被 steer 抑制掉的终态事件。
       *
       * SDK 若在处理排队消息前就收流（进程退出、上游断开），下面的 `!terminalQueued`
       * 分支本来会造一条 "stream ended before a terminal result" 的错误——但那一轮
       * 其实是**正常完成**过的，只是终态被这里扣着。留一份原件用来收尾，
       * 免得给用户一个凭空的失败。
       */
      let suppressedTerminal: TurnCompletedEvent | null = null

      /*
       * Turn Hold Watchdog: result 已到、turn 却被后台任务留着时的兜底。
       *
       * 正常情况下后续会有汇总回合的 result 把 turn 收掉；等不到时这里强制收尾，
       * 否则 turn 会一直 running 到协调器 30 分钟的 idle 看门狗（见 TURN_HOLD_TIMEOUT_MS）。
       * 任何新事件都算"仍有进展"，重新计时。
       */
      let holdTimer: ReturnType<typeof setTimeout> | null = null
      const clearHold = (): void => {
        if (holdTimer) clearTimeout(holdTimer)
        holdTimer = null
      }
      const armHold = (): void => {
        clearHold()
        holdTimer = setTimeout(() => {
          holdTimer = null
          if (terminalQueued) return
          log.warn(
            'turn held open past',
            TURN_HOLD_TIMEOUT_MS,
            'ms after result; forcing completion',
            { turnId: internalTurnId, activeTaskIds: backgroundTasks.activeTaskIds() },
          )
          for (const task of backgroundTasks.markStalled('回合已结束，未收到任务终态通知')) {
            pushEvent({ type: 'background_task_updated', turnId: internalTurnId, task })
          }
          pushEvent({
            type: 'turn_completed',
            turnId: internalTurnId,
            status: 'completed',
            usage: backgroundTasks.accumulatedUsage(),
          })
          terminalQueued = true
          inputController.close()
        }, TURN_HOLD_TIMEOUT_MS)
        holdTimer.unref?.()
      }

      try {
        for await (const msg of sdkQuery) {
          // 终态已经入队后只排空 SDK 的收尾帧，避免重复生成 turn_completed。
          if (terminalQueued) continue
          const events = this.processSdkMessage(
            msg,
            internalTurnId,
            args.sessionId,
            aggregator,
            backgroundTasks,
            () => {
              sawStreamEvents = true
            },
            sawStreamEvents,
          )
          // Steer Continuation: 还有排队的 steer 消息没跑，这个 result 只是它前面那一轮的
          // 边界，不是 turn 的终态——摘掉终态事件让 turn 继续，其余事件（flushPendingToolUse
          // 的产物等）照常发出去。只摘 completed：result 报错时那一轮已经失败，
          // 排队的消息未必还会被处理，此时如常收尾比让 turn 悬着更诚实。
          const steerHeld = pendingSteers > 0 ? takeSuppressibleTerminal(events) : null
          if (steerHeld) {
            pendingSteers -= 1
            suppressedTerminal = steerHeld
            log.debug('turn kept open for queued steer prompt', {
              turnId: internalTurnId,
              pendingSteers,
            })
          } else if (events.some((e) => e.type === 'turn_completed')) {
            // 正常收尾（或 result 报错收尾）——计数归零，避免残留影响后续判断。
            pendingSteers = 0
          }
          for (const ev of events) pushEvent(ev)
          const heldOpen =
            isSdkResultMessage(msg) && !events.some((e) => e.type === 'turn_completed')
          // result 被 hold 住 → 起计时；其余任何消息都说明还有进展 → 撤销计时。
          // steer 抑制掉的 result 同样走这条兜底：SDK 万一没有真的再跑一轮，
          // TURN_HOLD_TIMEOUT_MS 之后强制收尾，不会挂到协调器的 30 分钟看门狗。
          if (heldOpen) armHold()
          else clearHold()
          if (events.some((event) => event.type === 'turn_completed')) {
            terminalQueued = true
            // 先正常关闭 streaming input，让 SDK 自然收尾。直接 break async iterator
            // 可能被 SDK 视为宿主提前中断，并在 transcript 留下 user interrupted。
            inputController.close()
          }
        }
        if (!terminalQueued) {
          if (backgroundTasks.isCancelling()) {
            pushEvent({
              type: 'turn_completed',
              turnId: internalTurnId,
              status: 'interrupted',
              usage: backgroundTasks.accumulatedUsage(),
            })
          } else if (suppressedTerminal) {
            // Steer Continuation: 排队的消息没等到就收流——用被扣下的那个终态收尾，
            // 这一轮是真的跑完了，不该报错。
            pushEvent({ ...suppressedTerminal, usage: backgroundTasks.accumulatedUsage() })
          } else {
            pushEvent({
              type: 'error',
              turnId: internalTurnId,
              message: 'Claude SDK stream ended before a terminal result',
              recoverable: false,
            })
            pushEvent({
              type: 'turn_completed',
              turnId: internalTurnId,
              status: 'error',
              usage: backgroundTasks.accumulatedUsage(),
            })
          }
          terminalQueued = true
        }
        // turn 正常结束后，缓存可用模型列表（initializationResult 复用首次连接结果，零额外开销）
        // 这样下次 listModels() 能返回真实列表而非静态 fallback。
        const turnCwd = args.cwd
        if (!this.modelsCache || (turnCwd && !this.slashCommandsCache.has(turnCwd))) {
          try {
            const init = await sdkQuery.initializationResult()
            if (init.models && init.models.length > 0) {
              this.modelsCache = init.models
              log.info('cached', init.models.length, 'models from initializationResult')
            }
            // 命令表跟模型同来源。用户发过一条消息之后，斜杠联想就已经是热的了。
            if (turnCwd) {
              this.cacheSlashCommandsFrom(
                turnCwd,
                init.commands as unknown as RawSlashCommand[] | undefined,
              )
            }
          } catch (e) {
            log.debug('initializationResult for models cache failed:', e)
          }
        }
      } catch (e) {
        streamDone.error = e instanceof Error ? e : new Error(String(e))
        if (!terminalQueued) {
          if (backgroundTasks.isCancelling()) {
            pushEvent({
              type: 'turn_completed',
              turnId: internalTurnId,
              status: 'interrupted',
              usage: backgroundTasks.accumulatedUsage(),
            })
          } else {
            pushEvent({
              type: 'error',
              turnId: internalTurnId,
              message: streamDone.error.message,
              recoverable: false,
            })
            pushEvent({
              type: 'turn_completed',
              turnId: internalTurnId,
              status: 'error',
              usage: backgroundTasks.accumulatedUsage(),
            })
          }
        }
      } finally {
        clearHold()
        streamDone.value = true
        waker.resolve?.()
      }
    })()

    // ---- generator 主循环：从 queue yield 事件 ----
    let terminalYielded = false
    try {
      while (!streamDone.value || queue.length > 0) {
        while (queue.length > 0) {
          const event = queue.shift()!
          yield event
          if (event.type === 'turn_completed') terminalYielded = true
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
      // 消费方提前取消时才强制 abort。正常终态要等 pump 完成 finally，
      // 避免刚 yield turn_completed 就把已成功的 query 误标成 user interrupted。
      if (!streamDone.value && !terminalYielded) {
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
    backgroundTasks: ClaudeBackgroundTaskState,
    markStreamed: () => void,
    sawStreamEvents: boolean,
  ): TurnEvent[] {
    const events: TurnEvent[] = []

    if (msg.type === 'system') {
      switch (msg.subtype) {
        case 'background_tasks_changed':
        case 'task_started':
        case 'task_progress':
        case 'task_updated':
        case 'task_notification': {
          for (const task of backgroundTasks.handle(msg)) {
            events.push({ type: 'background_task_updated', turnId, task })
          }
          return events
        }
        /*
         * 本地斜杠命令的输出（SDK 注释点名 /voice、/usage）。
         *
         * 这类消息不走 assistant 通道，不接就被静默丢掉——用户按下命令后看到的是
         * 「消息发出去了，什么都没发生」。实测当前 CLI 下 /context、/usage、/config
         * 都还走普通 assistant 文本，所以这里是兜底而非主路径；但 SDK 明确定义了
         * 这条通道，版本一变就会用上。
         *
         * 当成一段 assistant 文本发出去（SDK 自己的说法也是 "Displayed as
         * assistant-style text in the transcript"）。
         */
        case 'local_command_output': {
          const text = (msg as { content?: unknown }).content
          if (typeof text === 'string' && text.length > 0) {
            const itemId = (msg as { uuid?: string }).uuid ?? randomUUID()
            markStreamed()
            events.push({ type: 'text_delta', turnId, itemId, text })
          }
          return events
        }
      }
    }

    // 子 Agent 的内部消息统一改道，绝不进主对话流。
    // 开了 forwardSubagentText 之后这类消息数量可观（文本 + 思考 + 每次工具调用），
    // 不拦住的话主对话会突然多出一堆用户没发起过的工具卡片和正文。
    const parentToolUseId = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id
    if (typeof parentToolUseId === 'string' && parentToolUseId.length > 0) {
      if (isSdkAssistantMessage(msg) || isSdkUserMessage(msg)) {
        events.push(...sdkSubagentToEvents(msg, turnId, parentToolUseId))
      }
      return events
    }

    if (isSdkInitMessage(msg)) {
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
      for (const task of backgroundTasks.handleUserMessage(msg)) {
        events.push({ type: 'background_task_updated', turnId, task })
      }
      // tool_result → tool_call_completed
      events.push(...sdkUserToolResultToEvents(msg, turnId))
      return events
    }

    if (isSdkResultMessage(msg)) {
      // result 是一次模型回合边界。存在后台任务时，首个 result 不是 CatMax turn 终态；
      // 等 task_notification 自动触发的汇总回合结束后才推 turn_completed。
      if (sawStreamEvents) {
        events.push(...aggregator.flushPendingToolUse())
      }
      if (backgroundTasks.classifyResult(msg) === 'intermediate') {
        log.debug('keeping Claude turn open for background tasks', {
          turnId,
          activeTaskIds: backgroundTasks.activeTaskIds(),
        })
        return events
      }

      const resultEvent = sdkResultToEvent(
        msg,
        turnId,
        backgroundTasks.accumulatedUsage(),
        backgroundTasks.isCancelling() ? 'interrupted' : undefined,
      )
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

  async steer(turnId: string, prompt: string): Promise<void> {
    const ctx = this.turnContexts.get(turnId)
    if (!ctx || ctx.interrupted) {
      log.debug('steer: no active context for turn', turnId)
      return
    }
    if (!ctx.inputController.push(prompt)) {
      log.debug('steer: input already closed for turn', turnId)
    }
  }

  /**
   * 停止单个后台任务。
   *
   * taskId 不带 turnId，所以要扫所有活跃 turn context 找持有它的那个。
   * 停止后 SDK 会发 status='stopped' 的 task_notification，快照由正常事件流更新——
   * 这里不自己造快照，避免和 SDK 的终态打架。
   */
  async stopBackgroundTask(taskId: string): Promise<void> {
    for (const ctx of this.turnContexts.values()) {
      if (!ctx.backgroundTasks.activeTaskIds().includes(taskId)) continue
      try {
        await ctx.query.stopTask(taskId)
      } catch (e) {
        log.warn('stopBackgroundTask failed:', taskId, e)
      }
      return
    }
    log.debug('stopBackgroundTask: no active context holds task', taskId)
  }

  async interrupt(turnId: string): Promise<void> {
    const ctx = this.turnContexts.get(turnId)
    if (!ctx) {
      log.debug('interrupt: no context for turn (already completed?)', turnId)
      return
    }
    if (ctx.interrupted) return
    ctx.interrupted = true
    const activeTaskIds = ctx.backgroundTasks.activeTaskIds()
    for (const task of ctx.backgroundTasks.markCancelling()) {
      ctx.pushEvent({ type: 'background_task_updated', turnId, task })
    }

    // 先显式停止后台任务，再中断父 query，避免留下脱离 UI 生命周期的子 Agent。
    // 每个 stopTask 单独限时：SDK 子进程无响应时它不会 reject，只会永远挂着。
    const stopResults = await Promise.allSettled(
      activeTaskIds.map((taskId) =>
        withTimeout(ctx.query.stopTask(taskId), INTERRUPT_CONTROL_TIMEOUT_MS, `stopTask ${taskId}`),
      ),
    )
    stopResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        log.warn('stopTask failed:', activeTaskIds[index], result.reason)
      }
    })

    // SDK 的 interrupt 是协作式的——发中断信号让 query 流尽快结束。
    // 同样要限时：卡住时直接 abort，abort 会让 for-await 抛出，pump 立刻推终态。
    // 不限时的话这个 await 永远不返回，UI 只能等协调器 15 秒的 cancel grace。
    try {
      await withTimeout(ctx.query.interrupt(), INTERRUPT_CONTROL_TIMEOUT_MS, 'query.interrupt()')
    } catch (e) {
      log.warn('query.interrupt() failed or timed out, falling back to abort:', e)
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

  // ============ catmax 覆盖配置注入 ============

  /**
   * 把 catmax 自己的覆盖配置交给 SDK 的 `Options.settings`。
   *
   * Claude Settings Profiles: 具体是哪个文件由「当前选中的档」决定
   * （userData/backend-settings/claude-profiles/<档 id>.json），
   * `claudeOverrideSettingsPath()` 已经把这一层解析掉了——这里不认识档的概念。
   * 用户选了「不启用」时它返回 null，等价于下面说的"没有覆盖配置"。
   *
   * ⚠️ 这里**故意不设 `settingSources`**。省略时 SDK 按 CLI 默认加载 user/project/local 三层，
   * 覆盖层落在优先级更高的 'flag' 层（managed > flag > user > project > local），于是
   * "覆盖文件里没写的 key 自动回落用户本地配置"是 SDK 自己保证的语义，catmax 不做任何合并。
   * 传 `[]` 会顺带把项目 CLAUDE.md 一起关掉（SDK 文档：必须含 'project' 才加载 CLAUDE.md），
   * 所以不能拿它来做隔离。
   *
   * 文件不存在时不设这个字段——"没有覆盖配置"必须等价于"完全走用户本地配置"，
   * 而给 SDK 传一个不存在的路径会直接报错。
   *
   * warmup 也要调这个，否则预热请求和正式 turn 的有效配置（model/env）不一致，
   * prompt-cache 共享前缀就白搭了。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private applyOverrideSettings(options: Record<string, any>): void {
    const path = claudeOverrideSettingsPath()
    const skillOverrides = disabledSkillOverrides()

    // 没有被关掉的技能时，保持原样传路径——"无覆盖 = catmax 不做任何合并"这条
    // 不变量对绝大多数用户都成立，不该为一个少数功能把所有人拖进合并逻辑。
    if (skillOverrides === null) {
      if (path !== null) options.settings = path
      return
    }

    /*
     * Unified Skill Center: 关技能只能落在这一层。
     *
     * 实测（SDK 0.3.220 / 内置 claude 2.1.220）：
     * - `Options.managedSettings.skillOverrides` **无效**——typings 跑在二进制前面了；
     * - `Options.skills` 白名单只是**上下文过滤器**，命令表纹丝不动，斜杠命令照样能打；
     * - 只有 `settings.skillOverrides` 真的把技能从命令表里摘掉（实测 79 → 77）。
     *
     * `settings` 同时接受路径和内联对象，这里用内联对象把用户的覆盖文件和 catmax
     * 算出来的 skillOverrides 合在一起，就不必再为此多落一个磁盘文件。合并只发生在
     * 顶层的一个 key 上，用户覆盖文件里自己写的 skillOverrides 优先——那是他显式
     * 表达的意图，不该被 UI 开关悄悄盖掉。
     */
    const base = path === null ? {} : readClaudeOverrideSettings(path)
    options.settings = mergeSkillOverrides(base, skillOverrides)
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
