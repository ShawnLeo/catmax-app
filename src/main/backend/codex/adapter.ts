/**
 * CodexAdapter —— codex app-server 的 AgentBackend 实现。
 *
 * 生命周期：
 *   1. initialize() —— spawn codex app-server 子进程，发 initialize 请求握手
 *   2. startSession() —— 调 thread/start 创建一个 codex thread
 *   3. startTurn() —— 调 turn/start，订阅 item/* 事件流，yield 为 TurnEvent
 *   4. interrupt() —— 调 turn/interrupt
 *   5. respondApproval() —— 响应 command/file approval 与 MCP elicitation
 *   6. dispose() —— kill 子进程
 *
 * 关键设计：
 * - turnId 是 App 内部生成（UUID），Adapter 内部维护 turnId → codex turn id 映射
 * - AsyncIterable<TurnEvent> 作为 startTurn 输出契约
 * - codex 协议细节（item 类型、approval 流程）在这里全部转译为 TurnEvent
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { pipeline } from 'node:stream/promises'

import { logger } from '@main/service/logger'
import { codexMcpKeyPath, codexTrustKeyPath, tomlKeySegment } from '@main/service/mcp-config-codec'
import { CODEX_CAPABILITIES } from '@shared/backend/builtin-capabilities'
import { upgradeMessageBlocks } from '@shared/backend/normalize-blocks'
import {
  agentMessageDeltaParamsSchema,
  commandApprovalParamsSchema,
  commandExecutionOutputDeltaParamsSchema,
  fileChangeApprovalParamsSchema,
  fileChangePatchUpdatedParamsSchema,
  itemCompletedParamsSchema,
  itemStartedParamsSchema,
  mcpServerElicitationRequestParamsSchema,
  modelListResultSchema,
  reasoningDeltaParamsSchema,
  turnCompletedParamsSchema,
  turnDiffUpdatedParamsSchema,
  turnErrorParamsSchema,
  turnStartedParamsSchema,
  type CodexItem,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpServerElicitationRequestParams,
} from '@shared/backend/schema'
import {
  BackendError,
  type AgentBackend,
  type ApprovalDecision,
  type ApprovalRequest,
  type BackendCapabilities,
  type EffortLevel,
  type ModelOption,
  type NormalizedMessage,
  type SessionSummary,
  type StartSessionArgs,
  type StartTurnArgs,
  type TurnCommand,
  type TurnEvent,
} from '@shared/backend/types'
import type { McpRuntimeStatus } from '@shared/mcp/types'

import { checkCliHealth } from '../health-check'
import { type ProcessSpawner, RealProcessSpawner } from '../process-spawner'
import {
  applyCodexStartupState,
  mapCodexMcpStatus,
  type CodexMcpServerStatusRaw,
  type CodexMcpStartupState,
} from '../shared/mcp-runtime-mapping'
import { buildWorkspaceInstructions, secondaryWorkspacePaths } from '../workspace-context'

import { readCodexDefaultProvider } from './default-provider'
import {
  codexTurnsToMessages,
  extractTurns,
  mergeAssistantAndToolMessages,
} from './history-mapping'
import {
  codexApprovalToRequest,
  codexItemToActivityBlock,
  codexItemToContentBlock,
  codexItemToToolCallInfo,
  ensureItemId,
} from './mapping'
import {
  classifyMessage,
  encodeNotification,
  encodeRequest,
  encodeResponse,
  LineBuffer,
  parseFrame,
} from './protocol'
import { CodexRpcError } from './rpc-error'

const log = logger.domain('codex-adapter')

/** 事件 sink —— 给测试用，可以注入自定义收集器 */
export interface TurnEventSink {
  push(event: TurnEvent): void
  close(): void
  /** 等待流结束（turn_completed 或 error） */
  done(): Promise<void>
}

/**
 * 外部模型列表来源（Protocol Bridge 用）。见 setModelListProvider 的说明。
 * 抽成接口而不是直接引用 bridgeManager，是为了不让 codex adapter 依赖 protocol 层。
 */
export interface CodexModelListProvider {
  /** 返回空数组表示「没有意见」，此时走 codex 自己的 model/list */
  list(): Promise<ModelOption[]>
  invalidate(): void
}

export interface CodexAdapterOptions {
  /** codex 可执行文件路径（默认从 PATH 找） */
  binaryPath?: string
  /** 自定义 spawner（测试用） */
  spawner?: ProcessSpawner
  /** 自定义 cwd（默认 process.cwd） */
  cwd?: string
  /**
   * codex 推 `skills/changed` 时回调（Unified Skill Center）。
   *
   * 这是个**空 params 的失效信号**（协议里就是 `Record<string, never>`），只说
   * "技能集合变了，自己重拉"。触发源实测是 `skills/extraRoots/set`——codex 0.145
   * 既不 watch 文件系统，`skills/config/write` 之后也不推。所以它只能当补充，
   * 不能当主刷新机制，真正的刷新靠 renderer 自己扫盘。
   */
  onSkillsChanged?: () => void
}

/** pending state：等待 approval 响应时持有的 resolver */
interface PendingApproval {
  resolve: (decision: ApprovalDecision['action']) => void
  turnId: string
  requestId: string
}

/** codex notification → TurnEvent 翻译中使用的内部 sink 状态 */
interface SinkState {
  queue: TurnEvent[]
  resolveWait: (() => void) | null
  done: boolean
}

/**
 * 从 rollout jsonl 头部读取会话使用的具体 model id。
 *
 * codex RPC（thread/list / thread/read）只返回 modelProvider（如 "openai"），
 * 不返回具体 model（如 "gpt-5.6-sol"）。具体 model 存在 rollout jsonl 的
 * turn_context 行（payload.model），通常在文件前 ~20 行内。
 *
 * 流式逐行读，遇到 turn_context 立即返回，避免读完整个大文件。
 * 文件不存在 / 解析失败 / 无 turn_context 行 → 返回 null（UI fallback 到默认 model）。
 */
async function readModelFromRollout(
  rolloutPath: string | null | undefined,
): Promise<string | null> {
  if (!rolloutPath) return null
  try {
    const stream = createReadStream(rolloutPath, { encoding: 'utf-8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        // turn_context 行特征：type 字段是 turn_context，payload 里有 model
        if (!line.includes('turn_context')) continue
        const parsed = JSON.parse(line) as {
          type?: string
          payload?: { model?: unknown }
        }
        if (parsed.type === 'turn_context' && typeof parsed.payload?.model === 'string') {
          return parsed.payload.model
        }
      }
    } finally {
      rl.close()
      stream.destroy()
    }
  } catch (e) {
    // 文件不存在 / 权限错误 / 损坏——静默返回 null，不阻塞扫描
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      log.warn('readModelFromRollout failed', rolloutPath, e)
    }
  }
  return null
}

export class CodexAdapter implements AgentBackend {
  readonly id = 'codex' as const

  readonly capabilities = CODEX_CAPABILITIES

  private opts: CodexAdapterOptions
  private spawner: ProcessSpawner
  private proc: ReturnType<ProcessSpawner['spawn']> | null = null
  private lineBuffer = new LineBuffer()
  private nextRequestId = 0
  private pendingRequests = new Map<
    number | string,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >()
  private pendingApprovals = new Map<string, PendingApproval>()
  private initialized = false
  /**
   * 进行中的 initialize Promise——并发去重。
   *
   * 多个调用者（listModels / startSession / reconcile 等）可能同时触发
   * ensureInitialized()。没有复用时，两个调用都检查 this.initialized===false
   * 后各自发 initialize 请求，codex 会拒绝第二个返回 "Already initialized" error，
   * 导致进程被 rejectAllPending 杀死、所有后续 RPC 失败。
   * 复用同一个 Promise：第一个调用 spawn+握手，其他调用 await 同一个 Promise。
   */
  private initializePromise: Promise<void> | null = null

  /**
   * model/list 缓存——避免每次 listModels() 都 RPC 往返。
   * 存的是 Promise（而不是已 resolve 的值），这样并发调用者共享同一次 RPC：
   *   - initialize() 预取 + 第一次 listModels() 同时触发时，只发一次 model/list
   *   - 失败时把缓存清空（设回 null），下次调用会重试
   * 进程退出时也清空（账户可能换了）。
   */
  private cachedModelsPromise: Promise<ModelOption[]> | null = null

  /**
   * server 名 → 最近一次 `mcpServer/startupStatus/updated`。
   *
   * 攒着而不是即时上报：这些通知跟 turn 无关，用处是 listMcpRuntime 时补上
   * `mcpServerStatus/list` 说不出来的失败原因。跟着进程走——进程换了就该清掉，
   * 否则会拿旧进程的失败去解释新进程的 server。
   */
  private mcpStartupStates = new Map<string, CodexMcpStartupState>()

  /** 当前 turn 的事件 sink（同一时刻只跑一个 turn） */
  private currentSink: TurnEventSink | null = null
  /** 内部 turnId → codex turnId 映射 */
  private turnIdMap = new Map<string, string>()
  /** 内部 turnId → codex threadId；当前 turn/interrupt 要求两个 id 同时提供。 */
  private turnThreadIdMap = new Map<string, string>()
  /** 在 Codex 返回真实 turn id 前收到的中断请求；绑定 id 后立即补发。 */
  private pendingInterrupts = new Set<string>()

  constructor(opts: CodexAdapterOptions = {}) {
    this.opts = opts
    this.spawner = opts.spawner ?? new RealProcessSpawner()
  }

  /** 运行时设置 binaryPath（settings 加载后注入；不影响已 spawn 的进程） */
  setBinaryPath(path: string): void {
    if (this.initialized) {
      log.warn('setBinaryPath called after initialize — will take effect on next re-init')
    }
    this.opts = { ...this.opts, binaryPath: path }
  }

  /** 读当前 binaryPath（applySettings 用来对比是否变化决定要不要清模型缓存） */
  getBinaryPath(): string | undefined {
    return this.opts.binaryPath
  }

  /** 注入额外的子进程环境变量（HTTPS_PROXY 等）；不影响已 spawn 的进程 */
  setExtraEnv(env: Record<string, string>): void {
    this.extraEnv = env
  }
  private extraEnv: Record<string, string> = {}

  /**
   * Protocol Bridge: 注入额外的 `-c key=value` 启动参数；不影响已 spawn 的进程。
   *
   * 协议桥用这个把 codex 的 model_provider 指到本机桥上，而不是去改用户的
   * ~/.codex/config.toml——传空数组就等于完全按用户自己的配置走。
   */
  setExtraArgs(args: string[]): void {
    this.extraArgs = args
  }
  private extraArgs: string[] = []

  /**
   * Protocol Bridge: 用外部模型列表顶掉 codex 自己的 `model/list`。
   *
   * codex 的 `model/list` 返回的是**编译进二进制的 ChatGPT 目录**，既不看
   * `model_provider` 也不去请求 provider 的 /v1/models（实测把 provider 指向本机桥后，
   * codex 全程没访问过桥的 /models，model/list 照样返回 gpt-*）。桥开着的时候这份列表
   * 是错的——用户看到 gpt-5.6-sol，实际请求打到的是 DeepSeek。所以由桥提供真实列表。
   *
   * provider 返回空数组 = 「我没有意见」，照常走 codex 自己的 model/list。
   */
  setModelListProvider(provider: CodexModelListProvider | null): void {
    // 桥开关翻转时模型缓存必须失效——否则关桥后 listModels() 还在返回上游那份列表，
    // resolveTurnModel() 会认为 `deepseek-v4-pro` 依然有效，照发给 ChatGPT。
    // 只在 有↔无 之间翻转时清：applySettings 每次都会调这个 setter，
    // 无脑清会让每次设置变更都多打一次 model/list。
    if ((this.modelListProvider === null) !== (provider === null)) {
      this.cachedModelsPromise = null
    }
    this.modelListProvider = provider
  }
  private modelListProvider: CodexModelListProvider | null = null

  /**
   * Protocol Bridge: resume 老会话时强制指定 model_provider。
   *
   * codex 把 provider **写死在 rollout 的 session_meta 里**，`thread/resume` 会把它
   * 连同历史一起恢复，**完全无视** spawn 时的 `-c model_provider=`。两个方向都会坏：
   *
   * - 开桥前建的会话 → 开桥后继续：provider 还是原厂，请求照直发去 ChatGPT，桥全程
   *   收不到东西。实测报 `The 'deepseek-v4-pro' model is not supported when using Codex
   *   with a ChatGPT account.`——模型名换成了桥的，provider 却没换。
   * - 开桥时建的会话 → 关桥后继续：rollout 里记着 `catmax-bridge`，而新进程没定义它，
   *   thread/resume 直接 `failed to load configuration: Model provider not found`，
   *   会话彻底打不开（后续 turn/start 连报 thread not found）。
   *
   * `thread/resume` 的 modelProvider 参数是唯一的覆盖口子，所以**两个方向都要显式传**：
   * 桥开着传桥的 id，桥关着传用户 config.toml 里生效的那个（不能硬编码 'openai'，
   * 用户很可能自定义过）。
   */
  setModelProvider(providerId: string | null): void {
    this.modelProvider = providerId
  }
  private modelProvider: string | null = null

  /** resume 参数：provider 必须显式给，两个方向都不能让 rollout 里的旧值生效 */
  private async resumeParams(backendThreadId: string): Promise<Record<string, unknown>> {
    // 桥关着时才去读 config.toml——桥开着时答案已经确定，没必要碰磁盘
    const provider = this.modelProvider ?? (await readCodexDefaultProvider())
    return { threadId: backendThreadId, modelProvider: provider }
  }

  // ============ 生命周期 ============

  async initialize(): Promise<void> {
    // 并发去重：进行中的 initialize 复用同一个 Promise，避免重复握手。
    // 见 initializePromise 字段注释——并发 initialize 会导致 codex 返回
    // "Already initialized" error 并杀死进程。
    if (this.initialized) return
    if (this.initializePromise) return this.initializePromise
    this.initializePromise = this.doInitialize()
    try {
      await this.initializePromise
    } finally {
      // 无论成功失败都清空（失败时允许下次重试）
      this.initializePromise = null
    }
  }

  private async doInitialize(): Promise<void> {
    if (!this.proc) {
      const binary = this.opts.binaryPath ?? 'codex'
      // codex 0.93+ 的 app-server 默认就是 stdio，不需要 `--listen stdio://`。
      // 旧版本（codex 0.x 早期）才有 --listen 参数。新版带上反而报错：
      //   error: unexpected argument '--listen' found
      // 这里不带，让两边都兼容（旧版默认行为也是 stdio）。
      // 同时注入 extraEnv（HTTPS_PROXY 等代理环境变量）——由 BackendManager.applySettings 设置。
      const proc = this.spawner.spawn({
        command: binary,
        // extraArgs 是协议桥的 `-c` 覆盖，放在子命令后面（codex 的 -c 是全局参数，
        // 位置无所谓，但排在后面便于日志里一眼看出哪些是 catmax 加的）
        args: ['app-server', ...this.extraArgs],
        env: { ...this.extraEnv },
        ...(this.opts.cwd !== undefined ? { cwd: this.opts.cwd } : {}),
      })
      this.proc = proc

      /**
       * 这批 handler 绑在**具体某个子进程**上，但它们操作的是适配器级别的共享状态
       * （pendingRequests / lineBuffer / initialized）。进程被换掉后，旧进程的迟到事件
       * 必须忽略，否则会污染新进程。
       *
       * 最典型的是重连（协议桥开关翻转会走 reconnectBackend → dispose + initialize）：
       * dispose 同步 kill，但 exit 事件下一个 tick 才到——那时新进程的握手请求已经挂在
       * 共享的 pendingRequests 里了，旧进程的 exit handler 一调 rejectAllPending 就会把它
       * reject 掉，initialize 抛 "codex process exited"，一路冒到 settings.update。
       */
      const isStale = (): boolean => this.proc !== proc

      proc.child.stdout?.on('data', (chunk: Buffer) => {
        if (isStale()) return
        this.onStdoutData(chunk)
      })
      proc.child.stderr?.on('data', (chunk: Buffer) => {
        if (isStale()) return
        // codex 的 stderr 带 ANSI 控制字符（颜色），先剥掉再处理
        const rawText = chunk.toString('utf-8').trim()
        // eslint-disable-next-line no-control-regex
        const text = rawText.replace(/\x1B\[[0-9;]*m/g, '')
        // 协议桥故意不实现 GET /v1/models（见 protocol/server.ts 的设计注释 + 设计文档 §3.8）：
        // 模型列表由 catmax 直接从上游拉（upstream-models.ts），桥对 /v1/models 一律 404。
        // codex 的 models manager 仍会周期性来探测 base_url，撞上桥的 404 后在 stderr 打
        // ERROR。这条日志不影响 turn、也不影响下拉框，属于已知噪音——直接静默，别吓到用户。
        if (
          text.includes('codex_models_manager') &&
          text.includes('failed to refresh available models') &&
          text.includes('桥不处理该路径')
        ) {
          return
        }
        log.warn('codex stderr:', text)
        // 监测致命的 API 错误（OpenAI 返回 400 等），立刻中断当前 turn——
        // 不然用户会等到 60s idle 超时才知道问题。
        // codex 的 stderr 里会带 "error=http 400 Bad Request: ..." 这样的字符串。
        const apiErrMatch = text.match(/error=http (\d+)[^:]*:\s*(.+)/)
        if (apiErrMatch) {
          const code = apiErrMatch[1] ?? ''
          const detail = (apiErrMatch[2] ?? '').slice(0, 300)
          const friendly = friendlyApiError(code, detail)
          log.warn(
            'codex API error detected',
            'hasSink=',
            !!this.currentSink,
            'hasTurnId=',
            !!this.findCurrentTurnId(),
          )
          if (this.currentSink) {
            const turnId = this.findCurrentTurnId() ?? ''
            log.warn('codex API error → pushing error event:', friendly)
            this.currentSink.push({
              type: 'error',
              turnId,
              message: friendly,
              recoverable: false,
            })
            // 紧接着推 turn_completed(error)，让 generator 正常结束
            this.currentSink.push({
              type: 'turn_completed',
              turnId,
              status: 'error',
            })
          }
        }
      })
      proc.child.on('exit', (code, signal) => {
        if (isStale()) {
          // dispose/重连主动换掉的旧进程，它的退场与当前连接无关
          log.debug('ignoring exit from stale codex process', { code, signal })
          return
        }
        log.warn('codex exited:', { code, signal })
        this.initialized = false
        // 进程死了，缓存的 model 列表也可能过时（比如用户重新登录了别的账户）——清掉。
        this.cachedModelsPromise = null
        // MCP 启动状态属于那个进程；留着会拿旧进程的失败去解释新进程的 server。
        this.mcpStartupStates.clear()
        // 进程死了，pending 的 request 全 reject（避免 30s 超时白等）
        this.rejectAllPending('codex process exited')
      })
    }

    // 发 initialize 握手
    try {
      await this.sendRequest('initialize', {
        clientInfo: { name: 'catmax-app', title: 'catmax', version: '0.1.0' },
        // openai/form MCP elicitation（Computer Use 的应用授权）属于扩展能力；
        // 显式声明后 app-server 才能把该类请求交给 CatMax 渲染。
        capabilities: { experimentalApi: true },
      })
    } catch (e) {
      // 握手失败——清理半连接的子进程，否则下次 initialize() 会复用死进程，
      // 永远超时（Bug C）。让下次调用重新 spawn。
      this.killAndClearProc()
      throw e
    }
    // 通知 initialized
    this.sendNotification('initialized', {})
    this.initialized = true
    log.info('initialized')
    // 预取 model/list 填充缓存——不 await 不阻塞 initialize，
    // 但第一次 startTurn 调 resolveDefaultModel 时大概率已命中缓存，
    // 省一次 RPC 往返。失败也无所谓，listModels() 自己会重试。
    void this.listModels().catch((e) => log.warn('model/list prefetch failed:', e))
  }

  /** kill 当前子进程并清空引用（用于 initialize 失败回滚） */
  private killAndClearProc(): void {
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM')
      } catch {
        // 已退出
      }
      this.proc = null
    }
    this.lineBuffer = new LineBuffer()
    this.initialized = false
    this.cachedModelsPromise = null
    this.mcpStartupStates.clear()
  }

  /** reject 所有 pending request（用于进程意外退出） */
  private rejectAllPending(reason: string): void {
    for (const [id, { reject }] of this.pendingRequests) {
      this.pendingRequests.delete(id)
      reject(new BackendError('protocol', reason))
    }
  }

  async healthCheck(): Promise<{ ok: boolean; version?: string; error?: string }> {
    // 用 `codex --version` 检测可用性 + 诊断失败原因。
    // 之前用 execSync + 只判断 ENOENT/兜底，把 macOS Gatekeeper 拦截（SIGKILL）等情况
    // 都笼统报 "spawn-failed"，用户没法知道为什么 codex 不可用。
    const binary = this.opts.binaryPath ?? 'codex'
    return checkCliHealth(binary, ['--version'])
  }

  async dispose(): Promise<void> {
    if (this.proc) {
      this.proc.kill('SIGTERM')
      this.proc = null
    }
    this.initialized = false
    this.cachedModelsPromise = null
    this.mcpStartupStates.clear()
    this.pendingRequests.clear()
    this.pendingApprovals.clear()
    // 旧进程可能死在半行 JSON 上，残留内容会把新进程的第一行拼坏——和 killAndClearProc 一致地重置
    this.lineBuffer = new LineBuffer()
    log.info('disposed')
  }

  getCapabilities(): BackendCapabilities {
    return this.capabilities
  }

  async listModels(): Promise<ModelOption[]> {
    // 命中缓存直接返回——startSession/startTurn 频繁调用 resolveDefaultModel，
    // 每次 RPC 往返一次 model/list 是浪费（codex 内部还要查 OpenAI）。
    // 缓存的是 Promise，并发调用共享同一次 RPC。
    if (this.cachedModelsPromise) return this.cachedModelsPromise

    this.cachedModelsPromise = (async () => {
      try {
        // 桥接管模型列表时优先用它——顺带省掉一次 spawn：光是列模型不必起 app-server
        const external = await this.modelListProvider?.list()
        if (external && external.length > 0) return external

        await this.ensureInitialized()
        const result = await this.sendRequest('model/list', {})
        const parsed = modelListResultSchema.parse(result)
        // codex capabilities.supportedEfforts 当前是 ['low','medium','high']，
        // 模型若声明了 supportedReasoningEfforts，只暴露这个子集里的——
        // 避免让 effort 下拉框出现 codex capabilities 还不认识的档位。
        const allowedEfforts = new Set(this.capabilities.supportedEfforts)
        const models: ModelOption[] = parsed.data.map((m) => {
          const supportedEfforts = m.supportedReasoningEfforts
            ?.map((e) => e.reasoningEffort)
            .filter((e) => allowedEfforts.has(e as EffortLevel))
            .map((e) => e as EffortLevel)
          return {
            id: m.id,
            // 实测 codex 返回的 displayName 跟 id 一模一样（"gpt-5.2-codex"），
            // 用户看着像 model id——保留 displayName 优先，没有再回退到 id。
            displayName: m.displayName ?? m.id,
            ...(m.description !== undefined ? { description: m.description } : {}),
            ...(m.isDefault === true ? { isDefault: true } : {}),
            ...(supportedEfforts !== undefined && supportedEfforts.length > 0
              ? { supportedEfforts }
              : {}),
          }
        })
        // 兜底：如果 codex 没标任何 isDefault，把第一项设成默认，
        // 这样 ChatView 的 watch 能 find(m => m.isDefault) 拿到一个有效 id。
        if (models.length > 0) {
          const hasDefault = models.some((m) => m.isDefault)
          if (!hasDefault) models[0]!.isDefault = true
        }
        return models
      } catch (e) {
        // 失败时清缓存，下次调用会重试——可能是临时网络抖动 / codex 暂时没起来。
        this.cachedModelsPromise = null
        log.warn('listModels failed, returning empty:', e)
        // 返回空数组——UI 下拉框显示空，由 backend 不可用 indicator 提示用户。
        return []
      }
    })()
    return this.cachedModelsPromise
  }

  /**
   * 解析默认模型 id —— 用户没在下拉框选时，startSession/startTurn 用这个。
   * 优先用 listModels() 返回的 isDefault 项；都没有（账户没登录/网络不通）就抛错，
   * 由上层显示明确错误，而不是发一个过时/无效的 model id 给 codex。
   */
  private async resolveDefaultModel(): Promise<string> {
    const models = await this.listModels()
    const def = models.find((m) => m.isDefault) ?? models[0]
    if (def) return def.id
    throw new BackendError(
      'protocol',
      '无法从 codex 获取可用模型列表——账户未登录 / 网络不通 / codex 版本不兼容',
    )
  }

  invalidateModelsCache(): void {
    // 清缓存后下次 listModels() 会重新发 model/list。
    // 触发场景：切走 backend、改 codex binaryPath、UI 手动刷新按钮。
    // 不需要清掉已 spawn 的子进程——model/list 是无状态的查询。
    this.cachedModelsPromise = null
    // 桥那边也有一层缓存，"刷新模型"要能真的重新打上游
    this.modelListProvider?.invalidate()
  }

  // ============ 技能开关 ============

  /**
   * Unified Skill Center: 把技能的开/关推给 codex。
   *
   * 落盘位置是**用户自己的** `~/.codex/config.toml`：
   * ```toml
   * [[skills.config]]
   * name = "web-perf"
   * enabled = false
   * ```
   * 重新置 `enabled: true` 会把整段删掉，是干净的 override 语义。所以终端里跑
   * codex 时这个技能也是关的——UI 上必须写清楚，见 AgentBackend.setSkillEnabled。
   *
   * ⚠️ 用 `name` 而不是 `path` 选择器，有两个原因：
   * 1. claude 那边只能按名字关（`skillOverrides` 没有路径选择器），两边都按名字
   *    才不会造出一个 catmax 自以为做到、实际做不到的语义；
   * 2. `path` 有个会骗人的坑——实测传技能**目录**时响应照样是
   *    `{"effectiveEnabled": false}`，但**根本没生效**；只有传 `skills/list` 返回的
   *    SKILL.md 全路径才算数。要改用 path 的话必须先把这条钉进测试。
   */
  async setSkillEnabled(name: string, enabled: boolean): Promise<void> {
    await this.ensureInitialized()
    await this.sendRequest('skills/config/write', { name, enabled })
  }

  /**
   * 让跑着的 app-server 重新扫技能目录。
   *
   * **codex 缓存技能列表，而且不 watch 文件系统**——实测：往扫描根里新建一个技能
   * 目录后，`skills/list` 默认（`forceReload` 缺省）仍然看不到它，等 6 秒也没有任何
   * 通知；只有 `forceReload: true` 那一次才会出现，之后缓存才更新。
   *
   * 所以 catmax 建软链 / 迁移 / 删除之后必须主动调这个，否则「修复可见性」按钮对
   * **当前这个** codex 进程是无效的：catmax 的列表刷新了（它自己扫盘），codex 却
   * 还拿着旧缓存，用户下一轮对话里那个技能依然不存在——界面显示成功、实际没生效，
   * 正是这个功能最该避免的那种撒谎。
   *
   * 进程没起来就直接返回：**不为了刷新而 spawn app-server**。冷启动本来就会扫最新的，
   * 为一次目录变更把 codex 拉起来是纯浪费（还会拖慢建软链的响应）。
   */
  async refreshSkills(): Promise<void> {
    if (!this.proc || !this.initialized) return
    await this.sendRequest('skills/list', { forceReload: true })
  }

  // ============ MCP 开关与信任 ============

  /**
   * Unified MCP Server Center: 把 server 的开/关写进 codex 的配置，并热重载。
   *
   * 实测要点（codex 0.145.0，沙盒 CODEX_HOME 里验证，没碰用户真实配置）：
   * - `config/value/write` **完整保留注释和格式**，包括行尾注释。所以绝不能手拼 TOML。
   * - **`value: null` 会把这个键删掉**，不是写一个 null。所以「重新启用」用 null 回到
   *   "没有 override" 的干净状态，比写 `enabled = true` 更贴近用户手写配置的样子。
   * - **写入会校验整份配置**：给一个配置里不存在的 server 写 `enabled` 会失败
   *   （`invalid transport`——光有 enabled 既没 command 也没 url）。所以必须写进
   *   **该 server 真正定义在的那个文件**，靠 `filePath` 指定；默认的用户 config.toml
   *   对一个定义在项目层的 server 是错的。
   *
   * **不带 `expectedVersion`**，尽管设计文档建议带。那个 sha256 乐观锁防的是
   * "读整份配置 → 改 → 写回"的竞态，而这里是一次定点 keyPath 编辑，codex 自己
   * 重读文件再拼接，catmax 这边根本没有 read-modify-write 窗口。带上它只会在
   * 用户刚好在别处编辑过配置时让开关失败——那时用户的意图明明是"把这个关掉"。
   */
  async setMcpEnabled(name: string, enabled: boolean, filePath?: string): Promise<void> {
    if (!this.proc || !this.initialized) {
      // 与 refreshSkills 同一条规矩：不为一次开关把 app-server 拉起来。
      // catmax 自己的状态已经落盘，冷启动时由 syncMcpOnStartup 补推。
      log.debug('setMcpEnabled skipped, codex not running', name)
      return
    }
    await this.sendRequest('config/value/write', {
      keyPath: codexMcpKeyPath(name, 'enabled'),
      value: enabled ? null : false,
      mergeStrategy: 'upsert',
      ...(filePath ? { filePath } : {}),
    })
    // 热重载，让**当前这些会话**立刻生效，而不是等下次 spawn。
    // 失败不算开关失败：配置已经写进去了，最坏是下次启动才生效。
    try {
      await this.sendRequest('config/mcpServer/reload', {})
    } catch (error) {
      log.warn('config/mcpServer/reload failed after setMcpEnabled', error)
    }
  }

  /**
   * 把一整个 MCP server 段写进 codex 的配置文件（Phase 5 的「写入用户配置」）。
   *
   * **整段写，不逐字段写。** `config/value/write` 每次都校验整份配置，逐字段写会在
   * 中间态失败——比如先写 `enabled` 时该 server 还没有 `command`/`url`，直接报
   * `invalid transport`。整段写一次到位，实测嵌套子表（`http_headers`）也会被正确
   * 展开成 `[mcp_servers."x".http_headers]`。
   *
   * 这里的 keyPath 用 `tomlKeySegment` 加引号——`config/value/write` **支持**带引号的
   * 段（与 `-c` 注入不同，那边不支持，见 canInjectIntoCodex），所以名字带点也能写。
   */
  async writeMcpServer(
    name: string,
    server: Record<string, unknown>,
    filePath?: string,
  ): Promise<void> {
    await this.ensureInitialized()
    await this.sendRequest('config/value/write', {
      keyPath: `mcp_servers.${tomlKeySegment(name)}`,
      value: server,
      mergeStrategy: 'upsert',
      ...(filePath ? { filePath } : {}),
    })
    try {
      await this.sendRequest('config/mcpServer/reload', {})
    } catch (error) {
      log.warn('config/mcpServer/reload failed after writeMcpServer', error)
    }
  }

  /**
   * 删掉一整个 MCP server 段。
   *
   * 与「重新启用」用的是同一条机制：`value: null` 是**删键**，不是写 null（实测）。
   * 传整段的 keyPath 就删整段，注释和其它段不受影响。
   */
  async removeMcpServer(name: string, filePath?: string): Promise<void> {
    await this.ensureInitialized()
    await this.sendRequest('config/value/write', {
      keyPath: `mcp_servers.${tomlKeySegment(name)}`,
      value: null,
      mergeStrategy: 'upsert',
      ...(filePath ? { filePath } : {}),
    })
    try {
      await this.sendRequest('config/mcpServer/reload', {})
    } catch (error) {
      log.warn('config/mcpServer/reload failed after removeMcpServer', error)
    }
  }

  /**
   * 把项目加进 codex 的信任列表，解掉 `<repo>/.codex/config.toml` 的 needs-trust。
   *
   * 写的是用户 config.toml 的 `[projects."<abs>"] trust_level = "trusted"`（实测生效，
   * 路径带点/空格都正确加引号）。
   *
   * ⚠️ 这不只是解开 MCP：信任一个项目意味着允许它的 `.codex/config.toml` 注入
   * hooks 和 exec policies。所以它是独立方法、由用户显式点，绝不能作为开关的副作用。
   */
  async trustProject(folderPath: string): Promise<void> {
    await this.ensureInitialized()
    await this.sendRequest('config/value/write', {
      keyPath: codexTrustKeyPath(folderPath),
      value: 'trusted',
      mergeStrategy: 'upsert',
    })
  }

  // ============ MCP 运行时状态 ============

  /**
   * Unified MCP Server Center: 读 codex 侧 MCP server 的连接情况。
   *
   * 实测要点（codex 0.145.0，`codex app-server generate-ts` 对过类型）：
   * - `initialize` 之后**立刻**就能调，不需要先开 thread；
   * - 响应里**没有状态字段**，只有 `serverInfo`（连上才非 null）、`tools`（**map** 不是数组）、
   *   `authStatus`。所以状态只能推断，见 mapCodexMcpStatus 的注释；
   * - `enabled = false` 的 server **照样出现在列表里**，serverInfo 为 null。别把它当失败；
   * - 有游标分页（`nextCursor`），server 多了不翻页就会少东西。
   *
   * 进程没起来直接返回空数组：**不为了拉状态 spawn app-server**（同 refreshSkills）。
   * 冷启一次 codex 只为了在设置页点亮几个徽章，代价和收益完全不成比例。
   */
  async listMcpRuntime(): Promise<McpRuntimeStatus[]> {
    if (!this.proc || !this.initialized) return []
    const out: McpRuntimeStatus[] = []
    let cursor: string | null = null
    try {
      // 上限兜底：翻页是靠服务端给的游标，万一它一直回同一个游标就会转不出去。
      for (let page = 0; page < 20; page++) {
        const params: Record<string, unknown> = { detail: 'toolsAndAuthOnly' }
        if (cursor) params.cursor = cursor
        const res = (await this.sendRequest('mcpServerStatus/list', params)) as {
          data?: CodexMcpServerStatusRaw[]
          nextCursor?: string | null
        }
        for (const raw of res.data ?? []) {
          const mapped = mapCodexMcpStatus(raw)
          // 列表推断不出状态时，用攒下来的启动通知补——那是 codex 唯一会说
          // 「失败了，因为 X」的地方。
          if (mapped)
            out.push(applyCodexStartupState(mapped, this.mcpStartupStates.get(mapped.name)))
        }
        cursor = res.nextCursor ?? null
        if (!cursor) break
      }
    } catch (error) {
      // 拉状态失败不该冒泡成用户可见的错误——设置页少几个徽章就是了。
      log.debug('mcpServerStatus/list failed', error)
    }
    return out
  }

  // ============ 会话 ============

  async startSession(
    args: StartSessionArgs,
  ): Promise<{ sessionId: string; backendThreadId: string }> {
    await this.ensureInitialized()
    // codex 0.93+ 的 thread/start 实际上要求 model（即便 schema 写 optional）
    // 不传会导致 thread/start 卡住直到超时。用户没在 UI 选 model 时，
    // 用 model/list 返回的默认模型（账户真实可用）。
    const model = args.model ?? (await this.resolveDefaultModel())
    const developerInstructions = buildWorkspaceInstructions(args.workspaceFolders)
    const writableRoots = secondaryWorkspacePaths(args.workspaceFolders)
    const result = await this.sendRequest('thread/start', {
      cwd: args.cwd,
      model,
      approvalPolicy: permissionToApproval(args.permissionMode),
      ...(developerInstructions !== undefined && { developerInstructions }),
      ...(writableRoots.length > 0 && {
        config: { sandbox_workspace_write: { writable_roots: writableRoots } },
      }),
    })
    const thread = (result as { thread?: { id?: string } }).thread
    if (!thread?.id) {
      throw new BackendError('protocol', 'thread/start did not return thread.id')
    }
    return {
      sessionId: randomUUID(),
      backendThreadId: thread.id,
    }
  }

  async listSessions(cwd?: string): Promise<SessionSummary[]> {
    await this.ensureInitialized()
    // thread/list 默认只返回 "interactive sources"（codex 桌面 app 创建的会话）。
    // catmax 通过 app-server 协议创建的会话属于 appServer / exec 等 source kind，
    // 不传 sourceKinds 会被默认过滤掉——历史上因此看不到 catmax 创建的 codex 会话。
    // 这里显式传所有 sourceKind，让历史会话（无论何种来源）都能被列出。
    const allSourceKinds = [
      'cli',
      'vscode',
      'exec',
      'appServer',
      'subAgent',
      'subAgentReview',
      'subAgentCompact',
      'subAgentThreadSpawn',
      'subAgentOther',
      'unknown',
    ]
    const params: Record<string, unknown> = { sourceKinds: allSourceKinds }
    if (cwd !== undefined) params.cwd = cwd

    // 分页：codex 返回 nextCursor，量大时一页拿不全。循环到 nextCursor 为空为止。
    // limit 取较大值减少往返（codex 默认页大小较小）；理论上限设 500 防失控。
    const all: SessionSummary[] = []
    let cursor: string | null = null
    for (let page = 0; page < 50; page++) {
      if (cursor) params.cursor = cursor
      const result = await this.sendRequest('thread/list', params)
      const resp = result as {
        data?: Array<Record<string, unknown>>
        nextCursor?: string | null
      }
      const threads = resp.data ?? []
      // 收集本页 thread 的元数据（不含 model），并行读 rollout 拿真实 model
      const pageMeta = threads.map((t) => ({
        id: (t.id as string) ?? '',
        title: (t.name as string | null) ?? (t.preview as string | null) ?? null,
        updatedAtSec: (t.updatedAt as number) ?? 0,
        cwd: (t.cwd as string) ?? undefined,
        rolloutPath: (t.path as string | null) ?? null,
      }))
      // 并行读 rollout 头部的 turn_context.model（每条只读前几行，遇到即停）
      const models = await Promise.all(pageMeta.map((m) => readModelFromRollout(m.rolloutPath)))
      for (let i = 0; i < pageMeta.length; i++) {
        const m = pageMeta[i]!
        // codex 的 updatedAt/createdAt 是秒级 Unix 时间戳，JS 用毫秒——必须 *1000，
        // 否则 lastActiveAt 会变成 1970 年，列表排序/显示全错。
        all.push({
          backendThreadId: m.id,
          title: m.title,
          lastActiveAt: m.updatedAtSec > 0 ? m.updatedAtSec * 1000 : Date.now(),
          // 具体 model 从 rollout jsonl 的 turn_context 行读；读不到（空会话/文件缺失）为 null，
          // UI 会 fallback 到默认 model。注意：不用 RPC 的 modelProvider（那是 "openai" 提供商，
          // 不是具体 model id，存了会导致下拉匹配不上显示"未选中"）
          model: models[i] ?? null,
          cwd: m.cwd,
        })
      }
      cursor = resp.nextCursor ?? null
      if (!cursor) break
    }
    return all
  }

  /**
   * 扫出某个 thread 的 rollout 文件绝对路径。
   *
   * codex 没有"按 thread id 查文件"的 RPC，只能扫目录：
   * ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl，threadId 是 UUID，
   * 所以跨所有日期目录匹配后缀 `-${threadId}.jsonl` 即可。
   * 理论上只会有一个匹配，返回全部让调用方决定（删除要删干净，fork 只取第一个）。
   */
  private async findRolloutFiles(backendThreadId: string): Promise<string[]> {
    const sessionsDir = join(homedir(), '.codex', 'sessions')
    try {
      // recursive: true 需要 Node 18.17+，catmax 要求 Node 22
      const entries = await readdir(sessionsDir, { recursive: true, withFileTypes: true })
      const suffix = `-${backendThreadId}.jsonl`
      return (
        entries
          .filter((e) => e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith(suffix))
          // ent.path 是父目录（Node readdir withFileTypes 提供）
          .map((e) => join((e as unknown as { path: string }).path ?? sessionsDir, e.name))
      )
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [] // sessions 目录不存在
      throw e
    }
  }

  async deleteSession(backendThreadId: string): Promise<void> {
    // codex CLI 当前没有暴露 thread 删除 RPC——按文件名扫 rollout 文件删。
    // 失败仅日志不抛——DB tombstone 兜底。
    try {
      const matches = await this.findRolloutFiles(backendThreadId)
      if (matches.length === 0) {
        log.warn('no codex rollout file found for thread', backendThreadId)
        return
      }
      for (const abs of matches) {
        await unlink(abs).catch(() => {})
        log.info('deleted codex rollout file', abs)
      }
    } catch (e) {
      log.warn('failed to delete codex session files', backendThreadId, e)
    }
  }

  /**
   * Session Fork: 复制会话——codex 没有 fork RPC，所以在 rollout 文件层面做。
   *
   * 之所以能这么干：整个 rollout 里**只有首行 session_meta.payload.id 是 thread id**，
   * 其余行都是 response_item，不含任何会话标识（见文件格式）。所以复制 = 换文件名
   * + 改首行的 id/timestamp，剩下的行原样透传。
   *
   * 新 id 用 UUIDv7 而不是 v4：codex 自己发的 thread id 都是 v7（时间有序），
   * 保持一致能让 codex 原生 UI 里的排序也正确。
   *
   * 不做的事：不 thread/start、不动 app-server 内存。fork 出的 thread 第一次
   * turn/start 必然 "thread not found"，startTurnRequest 会自动 thread/resume 一次
   * 把这个新 rollout 冷装回来——这条自愈路径本来就存在（进程重启时走的同一条）。
   */
  async forkSession(backendThreadId: string): Promise<{ backendThreadId: string }> {
    const sources = await this.findRolloutFiles(backendThreadId)
    const source = sources[0]
    if (!source) {
      throw new BackendError(
        'protocol',
        `codex forkSession: 找不到会话 ${backendThreadId} 的 rollout 文件，无法复制`,
      )
    }

    const now = new Date()
    const newThreadId = uuidV7(now)
    const target = codexRolloutPath(now, newThreadId)
    await mkdir(join(target, '..'), { recursive: true })

    // 逐行流式改写——rollout 可能有几十 MB，不整份读进内存。
    const input = createInterface({
      input: createReadStream(source, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    })
    const output = createWriteStream(target, { encoding: 'utf-8' })
    let isFirstLine = true
    try {
      await pipeline(
        (async function* () {
          for await (const line of input) {
            if (!isFirstLine) {
              yield `${line}\n`
              continue
            }
            isFirstLine = false
            yield `${rewriteSessionMetaLine(line, newThreadId, now)}\n`
          }
        })(),
        output,
      )
    } catch (e) {
      // 半成品 rollout 比没有更糟——codex 读到残缺文件会报解析错，而不是"会话不存在"
      await unlink(target).catch(() => {})
      throw e
    }

    log.info('forked codex thread', backendThreadId, '->', newThreadId, target)
    return { backendThreadId: newThreadId }
  }

  async resumeSession(backendThreadId: string): Promise<{ messages: never[] }> {
    await this.ensureInitialized()
    await this.sendRequest('thread/resume', await this.resumeParams(backendThreadId))
    // TODO Plan 3+: 把 codex 返回的 items 转成 NormalizedMessage[]
    // MVP 阶段先返回空（用户重开历史会话时显示空，能继续聊）
    return { messages: [] }
  }

  /**
   * 读会话历史：调 thread/read 拿 turn 数组，转成 NormalizedMessage[]。
   *
   * Resume 前置：codex 是 long-running app-server，thread 状态驻留在内存里。
   * 进程重启 / idle 回收后内存里没了这个 thread，后续 turn/start 会报
   * "thread not found"。thread/read 能从 rollout 文件冷读出历史（看似成功），
   * 但它不保证 thread 已注册——所以必须在 read 之前先 thread/resume 把 thread
   * 重新装回 app-server 内存，否则用户从历史会话继续聊第二轮会失败。
   * thread/resume 幂等：对已注册的 thread 调用是无副作用的 no-op。
   */
  async getHistory(
    backendThreadId: string,
    cwd?: string,
  ): Promise<{ messages: NormalizedMessage[]; aiTitle?: string | null }> {
    void cwd // codex 是 long-running app-server，cwd 在 thread/start 时已绑定，这里不用
    await this.ensureInitialized()
    try {
      await this.sendRequest('thread/resume', await this.resumeParams(backendThreadId))
    } catch (e) {
      if (isUnmaterializedThreadError(e)) {
        // thread/start 已分配 id、但首个 turn 尚在协调器队列中时还没有 rollout。
        // 这是合法的“新空会话”，切换页面读取历史不应打印错误或阻塞后续 turn。
        log.debug('thread not materialized before history read', backendThreadId)
      } else {
        // resume 失败不阻塞 read——rollout 文件还在就能读到历史。极端情况
        // （文件损坏 / 外部删除）下 read 自己会抛错。
        log.warn('thread/resume failed before read, continuing anyway', backendThreadId, e)
      }
    }
    let result: unknown
    try {
      result = await this.sendRequest('thread/read', {
        threadId: backendThreadId,
        includeTurns: true,
      })
    } catch (e) {
      if (isUnmaterializedThreadError(e)) {
        log.info('history not materialized yet, returning empty', backendThreadId)
        return { messages: [] }
      }
      throw e
    }
    const turns = extractTurns(result)
    const messages = codexTurnsToMessages(turns)
    const merged = mergeAssistantAndToolMessages(messages)
    log.info('history loaded', backendThreadId, merged.length, 'messages')
    return { messages: merged.map(upgradeMessageBlocks) }
  }

  // ============ Turn（核心） ============

  /**
   * 启动一轮 turn。返回 AsyncIterable<TurnEvent>。
   *
   * 注意：这是 async generator——main 进程内部用 for-await 消费。
   * BackendManager 会订阅它，把事件经 IPC 推给 renderer。
   */
  async *startTurn(args: StartTurnArgs): AsyncIterable<TurnEvent> {
    await this.ensureInitialized()
    const internalTurnId = randomUUID()
    yield { type: 'turn_started', turnId: internalTurnId, sessionId: args.sessionId }

    // 注册 turnIdMap 占位 + 预先建立 sink。
    // 必须在 sendRequest('turn/start') 之前完成——否则在 mock/PassThrough 测试
    // 中（mock 收到 request 后同步把 response + notifications 都 write 进 stdout），
    // 所有 'data' 事件会在 await 的微任务之前同步触发，导致 notifications 被丢弃。
    this.turnIdMap.set(internalTurnId, '')
    this.turnThreadIdMap.set(internalTurnId, args.sessionId)
    const state: SinkState = { queue: [], resolveWait: null, done: false }
    this.currentSink = makeSink(state)

    try {
      if (args.command) {
        /*
         * 命令 turn：不发 prompt，改发对应的 RPC。
         *
         * 拿不到 codex turn id——thread/compact/start 的响应是空对象 `{}`，不像
         * turn/start 会把 turn 带回来。但随后的 `turn/started` **通知**里有，
         * translateNotification 会回填 turnIdMap（见 case 'turn/started'），
         * 所以 interrupt 仍然可用。
         */
        await this.startCommandRequest(args.sessionId, args.command)
      } else {
        // args.sessionId 实际是 backendThreadId（startSession 返回的）
        // codex 0.93+ 的 turn/start 把 input 从 string 改成了 UserInput[] 数组：
        //   旧版: input: "用户文本"
        //   新版: input: [{ type: "text", text: "用户文本" }]
        // 不改的话 codex 报 "Invalid request: invalid type: string ..., expected a sequence"。
        // 同时 model 也是必需的（同 thread/start），用户没选时用 listModels 返回的默认。
        const model = await this.resolveTurnModel(args.model)
        // effort='none' 时产生零 reasoning token——codex 是两端里唯一能真正"关闭思考"的后端。
        // effort 字段 schema 是 z.string().optional()，'none' 合法。
        const turnResponse = await this.startTurnRequest(args.sessionId, {
          threadId: args.sessionId,
          input: [{ type: 'text', text: args.prompt }],
          model,
          ...(args.effort !== undefined ? { effort: args.effort } : {}),
          approvalPolicy: permissionToApproval(args.permissionMode),
        })
        const codexTurnId = (turnResponse as { turn?: { id?: string } }).turn?.id
        if (codexTurnId) {
          this.bindCodexTurnId(internalTurnId, codexTurnId)
        }
      }
    } catch (e) {
      this.currentSink = null
      this.turnIdMap.delete(internalTurnId)
      this.turnThreadIdMap.delete(internalTurnId)
      this.pendingInterrupts.delete(internalTurnId)
      yield {
        type: 'error',
        turnId: internalTurnId,
        message: e instanceof Error ? e.message : String(e),
        recoverable: false,
      }
      yield { type: 'turn_completed', turnId: internalTurnId, status: 'error' }
      return
    }

    // 订阅事件流，直到收到 turn/completed
    try {
      // Loop invariant: drain queue first, then check done. Notifications can
      // land in the queue synchronously before we even get here (mock streams),
      // and they may have already flipped `done` — we still must yield them.
      // 加 turn 级别的 idle 超时（60 秒没收到任何事件就报错）—— 否则 codex
      // 卡在 LLM API 调用时（如网络不通），UI 会一直显示 isRunning=true，无法操作。
      const TURN_IDLE_TIMEOUT_MS = 60_000
      let lastEventTime = Date.now()
      while (true) {
        while (state.queue.length > 0) {
          const event = state.queue.shift()!
          lastEventTime = Date.now()
          yield event
          if (event.type === 'turn_completed' || event.type === 'error') {
            return
          }
        }
        if (state.done) return
        // 计算剩余等待时间，idle 超时则 yield error
        const remaining = TURN_IDLE_TIMEOUT_MS - (Date.now() - lastEventTime)
        if (remaining <= 0) {
          yield {
            type: 'error',
            turnId: internalTurnId,
            message:
              'codex 60 秒内没有响应——可能是网络问题（api.openai.com / chatgpt.com 不可达）或 ChatGPT token 过期。请在终端跑 `codex exec "test"` 验证。',
            recoverable: false,
          }
          yield { type: 'turn_completed', turnId: internalTurnId, status: 'error' }
          return
        }
        await new Promise<void>((resolve) => {
          state.resolveWait = resolve
          // idle 超时 timer——到点 resolve 让循环重新检查 remaining
          setTimeout(resolve, Math.min(remaining, 5000))
        })
        state.resolveWait = null
      }
    } finally {
      this.currentSink = null
      this.turnIdMap.delete(internalTurnId)
      this.turnThreadIdMap.delete(internalTurnId)
      this.pendingInterrupts.delete(internalTurnId)
    }
  }

  /**
   * 定这一轮实际发出去的 model。
   *
   * 会话把 model 存在自己身上，而 provider 是全局的——协议桥开关一翻，两者就对不上了：
   * 关桥后老的桥会话还带着 `deepseek-v4-pro` 去请求 ChatGPT，codex 直接拒
   * （`The 'deepseek-v4-pro' model is not supported when using Codex with a ChatGPT account.`）。
   *
   * 渲染层的 ensureValidModel() 做的是同一件事，但它依赖 backendStore.models 已经刷新；
   * 桥开关翻转到用户发下一条消息之间有一段空档，这里是那段空档的兜底。
   *
   * 桥**开着**时不需要这层：bridge.ts 的 resolveModel() 已经把上游不认识的模型名换成兜底模型。
   * 拿不到模型列表（RPC 失败/空）时原样发出去——宁可让 codex 自己报错，也不要凭空改用户的选择。
   */
  private async resolveTurnModel(requested?: string): Promise<string> {
    if (!requested) return this.resolveDefaultModel()
    const models = await this.listModels().catch(() => [] as ModelOption[])
    if (models.length === 0 || models.some((m) => m.id === requested)) return requested
    const fallback = await this.resolveDefaultModel()
    log.info(`model ${requested} 不在当前 provider 的模型列表里，改用 ${fallback}`)
    return fallback
  }

  /**
   * 发一个作用于 thread 的请求；撞上 "thread not found" 就先 thread/resume 再重试一次。
   *
   * codex app-server 把 thread 状态放在**进程内存**里。进程一换（崩溃、空闲回收，
   * 或者协议桥开关翻转触发的 reconnect——那条路会 dispose + 重新 spawn），
   * 内存里的 thread 就没了，而 catmax 侧的会话还开着、还拿着旧 threadId，
   * 下一轮 turn/start 直接报 `thread not found: <id>`：用户看到的是"聊到一半
   * 突然发不出消息"。rollout 文件仍在磁盘上，thread/resume 能把它冷装回内存。
   *
   * getHistory 里已有同样的 resume 前置，但那只覆盖"打开历史会话"这条路径；
   * 会话已经开着时后端重启，没有任何东西会去 resume——必须在这里兜住。
   *
   * 命令 turn（thread/compact/start）跟普通 turn 一样吃这个问题，所以这里按方法名
   * 参数化而不是写死 turn/start——两条路复用同一份重试逻辑，不会漏掉其中一条。
   *
   * 只重试一次：resume 都失败说明 rollout 也没了，再转圈没有意义。
   */
  private async sendWithThreadResume(
    backendThreadId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      return await this.sendRequest(method, params)
    } catch (e) {
      if (!isThreadNotFoundError(e)) throw e
      log.info('thread not in app-server memory, resuming before retry', backendThreadId)
      await this.sendRequest('thread/resume', await this.resumeParams(backendThreadId))
      return await this.sendRequest(method, params)
    }
  }

  private startTurnRequest(
    backendThreadId: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return this.sendWithThreadResume(backendThreadId, 'turn/start', params)
  }

  /**
   * 用命令发起一轮 turn。
   *
   * 不认识的 kind 直接抛：静默降级成普通消息的表现是"命令发出去了，模型茫然地
   * 回问你要干什么"，比一条明确的错误难查得多（这正是把 `/compact` 当文本发给
   * codex 会发生的事）。
   */
  private async startCommandRequest(
    backendThreadId: string,
    command: TurnCommand,
  ): Promise<unknown> {
    if (command.kind !== 'compact') {
      throw new BackendError('protocol', `codex 不支持的命令：${String(command.kind)}`)
    }
    return this.sendWithThreadResume(backendThreadId, 'thread/compact/start', {
      threadId: backendThreadId,
    })
  }

  // ============ 反向控制 ============

  async interrupt(turnId: string): Promise<void> {
    const codexTurnId = this.turnIdMap.get(turnId)
    if (!codexTurnId) {
      // turn_started 会先把 adapter 内部 id 暴露给协调器，但 Codex 的真实 id 要等
      // turn/start 响应或 turn/started 通知。这个窗口里不能丢掉用户的停止请求。
      this.pendingInterrupts.add(turnId)
      log.info('interrupt queued until codex turn id is available:', turnId)
      return
    }
    await this.interruptCodexTurn(turnId, codexTurnId)
  }

  private bindCodexTurnId(internalTurnId: string, codexTurnId: string): void {
    this.turnIdMap.set(internalTurnId, codexTurnId)
    if (!this.pendingInterrupts.delete(internalTurnId)) return
    void this.interruptCodexTurn(internalTurnId, codexTurnId)
  }

  private async interruptCodexTurn(internalTurnId: string, codexTurnId: string): Promise<void> {
    const threadId = this.turnThreadIdMap.get(internalTurnId)
    if (!threadId) {
      log.warn('interrupt: no codex thread id for', internalTurnId)
      return
    }
    try {
      await this.sendRequest('turn/interrupt', { threadId, turnId: codexTurnId })
    } catch (e) {
      log.error('interrupt failed:', e)
    }
  }

  async respondApproval(decision: ApprovalDecision): Promise<void> {
    const pending = this.pendingApprovals.get(decision.requestId)
    if (!pending) {
      log.warn('respondApproval: no pending approval for', decision.requestId)
      return
    }
    this.pendingApprovals.delete(decision.requestId)
    pending.resolve(decision.action)
  }

  async steer(turnId: string, prompt: string): Promise<void> {
    const codexTurnId = this.turnIdMap.get(turnId)
    if (!codexTurnId) return
    // codex 0.93+ turn/steer 的 input 也是 UserInput[] 数组（同 turn/start）
    await this.sendRequest('turn/steer', {
      turnId: codexTurnId,
      input: [{ type: 'text', text: prompt }],
    })
  }

  // ============ 内部：stdin/stdout 处理 ============

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize()
    }
  }

  /** 发 JSON-RPC 请求，等响应 */
  private sendRequest(method: string, params: unknown): Promise<unknown> {
    if (!this.proc) {
      return Promise.reject(new BackendError('not-initialized', 'process not spawned'))
    }
    const id = this.nextRequestId++
    const frame = encodeRequest(method, params, id)
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject })
      this.proc!.write(frame + '\n')
      // 30s 超时
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id)
          reject(new BackendError('timeout', `request ${method} timed out`))
        }
      }, 30000)
    })
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.proc) return
    this.proc.write(encodeNotification(method, params) + '\n')
  }

  /** stdout 数据到达，切行、解析、分发 */
  private onStdoutData(chunk: Buffer): void {
    const lines = this.lineBuffer.push(chunk)
    for (const line of lines) {
      const msg = parseFrame(line)
      if (!msg) continue
      const classified = classifyMessage(msg)
      if (!classified) continue

      switch (classified.kind) {
        case 'response':
          this.handleResponse(classified.message)
          break
        case 'notification':
          this.handleNotification(classified.message)
          break
        case 'server-request':
          this.handleServerRequest(classified.message)
          break
      }
    }
  }

  private handleResponse(msg: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(msg.id)
    if (!pending) return
    this.pendingRequests.delete(msg.id)
    if (msg.error) {
      // 带上 code / data 再 reject。codex 的结构化错误码就藏在 data 里
      // （例如配置写入冲突是 `data.config_write_error_code = "configVersionConflict"`），
      // 只留 message 的话上层就只能对英文散文做字符串匹配——那是最脆的一种判断。
      pending.reject(new CodexRpcError(msg.error.message, msg.error.code, msg.error.data))
    } else {
      pending.resolve(msg.result)
    }
  }

  /**
   * `mcpServer/startupStatus/updated` —— codex 唯一会说出「启动失败」的地方。
   *
   * `mcpServerStatus/list` 的响应里**没有状态字段**（实测），所以失败的 server 在那份
   * 列表里和「被关掉的」「还在启起来的」长得一模一样（serverInfo 都是 null）。
   * 只有这条通知带 `status` + `error` + `failureReason`。
   *
   * 存起来而不是往 TurnEvent 里推：它跟 turn 无关，用途是下次 listMcpRuntime 时把
   * 推断出来的 unknown 补成真状态。收不到就维持 unknown——**不猜**。
   *
   * ⚠️ 实测中这条通知在 initialize 后的 4 秒内一次都没推过（本机两个 stdio server），
   * 所以它只能当补充，不能当唯一来源。真正的主力仍是 mcpServerStatus/list。
   */
  private handleMcpStartupStatus(params: unknown): void {
    const raw = params as
      { name?: unknown; status?: unknown; error?: unknown; failureReason?: unknown } | undefined
    if (typeof raw?.name !== 'string' || typeof raw.status !== 'string') return
    this.mcpStartupStates.set(raw.name, {
      status: raw.status,
      error: typeof raw.error === 'string' ? raw.error : null,
      // "reauthenticationRequired" 是唯一的取值，映射成统一的 needs-auth。
      needsAuth: raw.failureReason === 'reauthenticationRequired',
    })
  }

  private handleNotification(msg: JsonRpcNotification): void {
    // 跟 turn 无关的通知要在 currentSink 检查**之前**处理。技能变更几乎总是发生在
    // 没有 turn 在跑的时候，放在下面那个 early return 后面等于永远收不到。
    if (msg.method === 'skills/changed') {
      this.opts.onSkillsChanged?.()
      return
    }
    // MCP 启动状态同理——它几乎总在没有 turn 的时候推（server 是随 app-server 启动
    // 拉起来的），放在下面那个 early return 之后就永远收不到。
    if (msg.method === 'mcpServer/startupStatus/updated') {
      this.handleMcpStartupStatus(msg.params)
      return
    }
    if (!this.currentSink) {
      // 没有 turn 在跑，忽略
      return
    }
    const event = this.translateNotification(msg.method, msg.params)
    if (event) {
      this.currentSink.push(event)
    }
  }

  /** 把 codex notification 转成 TurnEvent */
  private translateNotification(method: string, params: unknown): TurnEvent | null {
    // 找当前活跃的 turnId
    const internalTurnId = this.findCurrentTurnId()
    if (!internalTurnId) return null

    switch (method) {
      case 'turn/started': {
        const r = turnStartedParamsSchema.safeParse(params)
        if (!r.success) return null
        const codexTurnId = r.data.turn.id
        this.bindCodexTurnId(internalTurnId, codexTurnId)
        return {
          type: 'turn_started',
          turnId: internalTurnId,
          sessionId: internalTurnId,
        }
      }
      case 'turn/completed': {
        const r = turnCompletedParamsSchema.safeParse(params)
        if (!r.success) return null
        const raw = r.data.turn.status
        const status: 'completed' | 'interrupted' | 'error' =
          raw === 'completed' ? 'completed' : raw === 'interrupted' ? 'interrupted' : 'error'
        return { type: 'turn_completed', turnId: internalTurnId, status }
      }
      // codex 把「这一轮失败了」通过 error 通知发出来，**不是**走 turn/start 的 RPC 响应。
      // 以前这里没处理，事件被整个丢掉：turn/completed 里只有一个光秃秃的 status=error，
      // UI 上就是"消息发出去了，什么都没发生"，用户只能干等 60s idle 超时。
      // 典型触发：provider 和 model 对不上（关桥后老会话还带着上游模型名）。
      case 'error': {
        const r = turnErrorParamsSchema.safeParse(params)
        if (!r.success) return null
        // willRetry=true 是重试中间态（"Reconnecting... 1/5"），报给用户只会造成误解
        if (r.data.willRetry) {
          log.info('codex 正在重试:', r.data.error.message)
          return null
        }
        const message = codexErrorMessage(r.data.error.message)
        log.warn('codex turn error:', message)
        return { type: 'error', turnId: internalTurnId, message, recoverable: false }
      }
      case 'item/agentMessage/delta': {
        const r = agentMessageDeltaParamsSchema.safeParse(params)
        if (!r.success) return null
        return {
          type: 'text_delta',
          turnId: internalTurnId,
          itemId: r.data.itemId,
          text: r.data.delta,
        }
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const r = reasoningDeltaParamsSchema.safeParse(params)
        if (!r.success) return null
        return {
          type: 'reasoning_delta',
          turnId: internalTurnId,
          itemId: r.data.itemId,
          text: r.data.delta,
          completedLabel: '已处理',
        }
      }
      case 'item/commandExecution/outputDelta': {
        const r = commandExecutionOutputDeltaParamsSchema.safeParse(params)
        if (!r.success) return null
        return {
          type: 'codex_activity_output_delta',
          turnId: internalTurnId,
          itemId: r.data.itemId,
          text: r.data.delta,
        }
      }
      case 'item/fileChange/patchUpdated': {
        const r = fileChangePatchUpdatedParamsSchema.safeParse(params)
        if (!r.success) return null
        const block = codexItemToActivityBlock({
          type: 'fileChange',
          id: r.data.itemId,
          status: 'inProgress',
          changes: r.data.changes,
        } as CodexItem)
        return block
          ? {
              type: 'content_block_upsert',
              turnId: internalTurnId,
              itemId: r.data.itemId,
              block,
            }
          : null
      }
      case 'turn/diff/updated': {
        const r = turnDiffUpdatedParamsSchema.safeParse(params)
        if (!r.success) return null
        return {
          type: 'codex_turn_diff_updated',
          turnId: internalTurnId,
          diff: r.data.diff,
        }
      }
      case 'item/started': {
        const r = itemStartedParamsSchema.safeParse(params)
        if (!r.success) return null
        return this.translateItemStarted(r.data.item, internalTurnId)
      }
      case 'item/completed': {
        const r = itemCompletedParamsSchema.safeParse(params)
        if (!r.success) return null
        return this.translateItemCompleted(r.data.item, internalTurnId)
      }
      default:
        // 忽略其他通知（thread/* 等）
        return null
    }
  }

  private translateItemStarted(item: CodexItem, turnId: string): TurnEvent | null {
    const block = codexItemToContentBlock(item)
    if (block) {
      return { type: 'content_block_upsert', turnId, itemId: item.id, block }
    }

    const itemId = ensureItemId(item.id, randomUUID())
    const toolInfo = codexItemToToolCallInfo(item)
    if (toolInfo) {
      return {
        type: 'tool_call_started',
        turnId,
        itemId,
        tool: toolInfo,
      }
    }
    return null
  }

  private translateItemCompleted(item: CodexItem, turnId: string): TurnEvent | null {
    const block = codexItemToContentBlock(item)
    if (block) {
      return {
        type: 'content_block_upsert',
        turnId,
        itemId: item.id,
        block,
        completed: true,
      }
    }

    const itemId = ensureItemId(item.id, randomUUID())
    const toolInfo = codexItemToToolCallInfo(item)
    if (toolInfo) {
      const raw = item as CodexItem & { result?: unknown; error?: string; status?: string }
      const ok = !raw.error && raw.status !== 'failed'
      return {
        type: 'tool_call_completed',
        turnId,
        itemId,
        output: {
          ok,
          summary: raw.error ?? raw.status ?? (ok ? 'completed' : 'failed'),
          ...(raw.result !== undefined ? { output: JSON.stringify(raw.result, null, 2) } : {}),
        },
      }
    }
    return null
  }

  /** server 主动发的请求（approval）—— 需要响应 */
  private handleServerRequest(msg: JsonRpcRequest): void {
    if (msg.method === 'item/commandExecution/requestApproval') {
      const r = commandApprovalParamsSchema.safeParse(msg.params)
      if (!r.success) return
      const internalTurnId = this.findCurrentTurnId()
      if (!internalTurnId) return
      const requestId = String(msg.id)
      const request = codexApprovalToRequest(
        'shell_command',
        r.data.command,
        r.data.cwd,
        r.data.reason,
      )
      this.registerApproval(requestId, internalTurnId, msg.id, request)
    } else if (msg.method === 'item/fileChange/requestApproval') {
      const r = fileChangeApprovalParamsSchema.safeParse(msg.params)
      if (!r.success) return
      const internalTurnId = this.findCurrentTurnId()
      if (!internalTurnId) return
      const requestId = String(msg.id)
      // file_change 的具体 changes 在 item 里，approval 通知不带
      const request = codexApprovalToRequest('file_edit', undefined, undefined, r.data.reason)
      this.registerApproval(requestId, internalTurnId, msg.id, request)
    } else if (msg.method === 'mcpServer/elicitation/request') {
      const r = mcpServerElicitationRequestParamsSchema.safeParse(msg.params)
      if (!r.success) {
        log.warn('invalid MCP elicitation request:', r.error.message)
        this.writeServerResponse(msg.id, {
          action: 'cancel',
          content: null,
          _meta: null,
        })
        return
      }
      const internalTurnId = this.findCurrentTurnId()
      if (!internalTurnId) {
        // 没有活动 turn 就没有 UI 可以承载确认，明确 cancel，避免 MCP server 永久等待。
        this.writeServerResponse(msg.id, {
          action: 'cancel',
          content: null,
          _meta: null,
        })
        return
      }
      if (!canRenderMcpElicitation(r.data)) {
        // CatMax 当前只承载“授权确认”表单。URL 流程和需要任意用户输入的表单
        // 不能靠允许/拒绝按钮正确完成，按 app-server 协议明确 cancel。
        log.warn('unsupported MCP elicitation form:', r.data.mode, r.data.serverName)
        this.writeServerResponse(msg.id, {
          action: 'cancel',
          content: null,
          _meta: null,
        })
        return
      }
      this.registerMcpElicitation(String(msg.id), internalTurnId, msg.id, r.data)
    } else {
      log.warn('unhandled server request:', msg.method)
    }
  }

  /** 注册 pending approval，推 approval_requested 给 UI，等用户决策后写响应 */
  private registerApproval(
    requestId: string,
    internalTurnId: string,
    rawMsgId: number | string,
    request: ReturnType<typeof codexApprovalToRequest>,
  ): void {
    const promise = new Promise<ApprovalDecision['action']>((resolve) => {
      this.pendingApprovals.set(requestId, {
        resolve,
        turnId: internalTurnId,
        requestId,
      })
    })
    // 推送 approval_requested 给 UI
    this.currentSink?.push({
      type: 'approval_requested',
      turnId: internalTurnId,
      requestId,
      request,
    })
    // 等用户决策后发响应
    void promise.then((action) => {
      const decision =
        action === 'approve'
          ? 'accept'
          : action === 'approve_always'
            ? 'acceptForSession'
            : 'decline'
      if (this.proc) {
        this.proc.write(encodeResponse(rawMsgId, { decision }) + '\n')
      }
    })
  }

  /** 把 MCP elicitation 映射为 CatMax 权限面板，并按 MCP 协议返回 action/content/_meta。 */
  private registerMcpElicitation(
    requestId: string,
    internalTurnId: string,
    rawMsgId: number | string,
    params: McpServerElicitationRequestParams,
  ): void {
    if (params.mode === 'url') return
    const persistence = extractMcpPersistence(params._meta)
    const request: ApprovalRequest = {
      kind: 'mcp',
      title: params.message,
      detail: formatMcpElicitationDetail(params),
      riskLevel: 'medium',
      displayName: params.serverName === 'computer-use' ? 'Computer Use' : params.serverName,
      description: `MCP server：${params.serverName}`,
      decisionReason: 'MCP server 请求操作本机应用，需要由你明确授权。',
      ...(persistence.length > 0 ? { approvalPersistence: persistence } : {}),
    }

    const promise = new Promise<ApprovalDecision['action']>((resolve) => {
      this.pendingApprovals.set(requestId, {
        resolve,
        turnId: internalTurnId,
        requestId,
      })
    })
    this.currentSink?.push({
      type: 'approval_requested',
      turnId: internalTurnId,
      requestId,
      request,
    })

    void promise.then((action) => {
      if (action === 'reject') {
        this.writeServerResponse(rawMsgId, {
          action: 'decline',
          content: null,
          _meta: null,
        })
        return
      }

      const selectedPersistence =
        action === 'approve_always'
          ? persistence.includes('always')
            ? 'always'
            : persistence.includes('session')
              ? 'session'
              : null
          : null
      this.writeServerResponse(rawMsgId, {
        action: 'accept',
        content: buildMcpElicitationContent(
          params.requestedSchema,
          selectedPersistence === 'always',
        ),
        _meta: selectedPersistence ? { persist: selectedPersistence } : null,
      })
    })
  }

  private writeServerResponse(id: number | string, result: unknown): void {
    if (this.proc) {
      this.proc.write(encodeResponse(id, result) + '\n')
    }
  }

  private findCurrentTurnId(): string | null {
    // 简化：取 turnIdMap 第一个 entry（同时只跑一个 turn）
    for (const [internal] of this.turnIdMap) {
      return internal
    }
    return null
  }
}

/** app-server 内存里没有这个 thread（进程重启过）——rollout 还在，resume 能救回来 */
function isThreadNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('thread not found')
}

/** thread 刚 start、首个 turn 还没落盘——磁盘上压根没有 rollout，resume 救不回来 */
function isUnmaterializedThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('no rollout found for thread id') ||
    message.includes('is not materialized yet')
  )
}

/**
 * codex `error` 通知里的 message 常常是**一整个 JSON 字符串**，真正的人话埋在 detail 里：
 *   "{\"detail\":\"The 'deepseek-v4-pro' model is not supported when using Codex with
 *     a ChatGPT account.\"}"
 * 原样丢给用户是一串转义，所以先剥出来，再走和 stderr 那条路一样的中文翻译。
 */
function codexErrorMessage(raw: string): string {
  let detail = raw
  const trimmed = raw.trim()
  // 协议桥留下的历史被原厂拒了——错误原文完全不提 provider，用户无从下手。
  // 两种表现取决于历史里存的是什么：带签名的报"验证不了"，只有 id 的报 404 找不到 item。
  // 根因相同：reasoning item 属于生成它的那个 provider，换 provider 后无法被接受。
  const crossProviderReasoning =
    (raw.includes('encrypted content') && raw.includes('could not be verified')) ||
    (raw.includes('Items are not persisted when `store`') && raw.includes('not found'))
  if (crossProviderReasoning) {
    return `这个会话是在协议桥开启时创建的，它的历史里带着上游模型的推理记录，原厂 OpenAI 不接受。
这是协议层面的限制：推理记录属于生成它的那个供应商，换供应商后无法继续同一个会话。

解决：重新开启协议桥继续这个会话，或者新建一个会话。`
  }
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { detail?: unknown; error?: { message?: unknown } }
      if (typeof parsed.detail === 'string') detail = parsed.detail
      else if (typeof parsed.error?.message === 'string') detail = parsed.error.message
    } catch {
      // 不是合法 JSON 就按原文处理
    }
  }
  // friendlyApiError 认得的模式（model 不支持 / 401 / 429…）翻译成中文，否则原样返回
  const friendly = friendlyApiError('', detail)
  return friendly.startsWith('OpenAI API 错误') ? detail : friendly
}

/**
 * 把 codex stderr 里的 OpenAI API 错误（"error=http 400: ..."）翻译成对用户友好的中文提示。
 * codex 自己不会通过 stdout 把 API 错误通知给客户端（catmax），只在 stderr 打日志——
 * 所以这里要从 stderr 主动抓取并转成 error event 推给 UI，否则用户要等 60s idle 超时。
 */
function friendlyApiError(httpCode: string, detail: string): string {
  // 常见模式："The 'XXX' model is not supported when using Codex with a ChatGPT account."
  const modelMatch = detail.match(/'([^']+)' model is not supported/)
  if (modelMatch) {
    return `OpenAI 拒绝了请求：${modelMatch[1]} model 不能用于当前账户。
可能原因：你登录的是 ChatGPT 免费账户（chatgpt_plan_type=free），免费账户不支持 codex 调 LLM API。
解决：登录 ChatGPT Plus / Pro / Team 账户，或换用 API Key 登录（codex login --api-key）。`
  }

  if (httpCode === '401') {
    return `OpenAI 认证失败（401）。ChatGPT token 可能已过期——请在终端跑 \`codex login\` 重新登录。`
  }
  if (httpCode === '429') {
    return `OpenAI 限流（429）。请求过于频繁或配额耗尽，稍后再试。`
  }
  if (httpCode.startsWith('5')) {
    return `OpenAI 服务器错误（${httpCode}）。稍后再试。`
  }

  return `OpenAI API 错误（HTTP ${httpCode}）：${detail}`
}

/** 把 codex 的权限模式翻译成 codex 的 approvalPolicy */
type CodexApprovalPolicy =
  | string
  | {
      granular: {
        mcp_elicitations: boolean
        rules: boolean
        sandbox_approval: boolean
        request_permissions: boolean
        skill_approval: boolean
      }
    }

function permissionToApproval(mode?: string): CodexApprovalPolicy | undefined {
  switch (mode) {
    case 'default':
      return 'untrusted'
    case 'acceptEdits':
    case 'auto':
      // 旧 codex 用 'on-failure'（沙箱失败时才询问）；新 codex 已移除该变体，
      // 只接受 untrusted|on-request|granular|never。改用 'on-request'（agent
      // 主动请求时询问）——这是语义最接近的合法值，避免 "unknown variant" 报错。
      return 'on-request'
    case 'plan':
      return 'never'
    case 'dontAsk':
    case 'bypassPermissions':
      // 文件/终端仍保持“不询问”，但让 Computer Use 等 MCP server 的独立授权
      // 进入客户端。否则 app-server 会自动拒绝 elicitation，UI 永远看不到弹窗。
      return {
        granular: {
          mcp_elicitations: true,
          rules: false,
          sandbox_approval: false,
          request_permissions: false,
          skill_approval: false,
        },
      }
    default:
      return undefined
  }
}

function extractMcpPersistence(meta: unknown): Array<'session' | 'always'> {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return []
  const persist = (meta as Record<string, unknown>).persist
  const values = Array.isArray(persist) ? persist : typeof persist === 'string' ? [persist] : []
  return values.filter(
    (value): value is 'session' | 'always' => value === 'session' || value === 'always',
  )
}

function formatMcpElicitationDetail(params: McpServerElicitationRequestParams): string {
  return params.message
}

/**
 * CatMax 的权限面板不是通用表单渲染器。空表单，或只要求
 * allowPersistentApproval 的 Computer Use 表单，可以由允许/拒绝按钮完整表达；
 * 其他表单必须 cancel，不能提交一个可能违反 requestedSchema 的空对象。
 */
function canRenderMcpElicitation(params: McpServerElicitationRequestParams): boolean {
  if (params.mode === 'url') return false
  if (
    !params.requestedSchema ||
    typeof params.requestedSchema !== 'object' ||
    Array.isArray(params.requestedSchema)
  ) {
    return false
  }
  const schema = params.requestedSchema as Record<string, unknown>
  const required = Array.isArray(schema.required) ? schema.required : []
  return required.every((field) => field === 'allowPersistentApproval')
}

/**
 * Computer Use 的 openai/form schema 可能包含 allowPersistentApproval。
 * 只有 schema 明确声明该字段时才回传，避免 additionalProperties=false 的表单拒绝响应。
 */
function buildMcpElicitationContent(
  requestedSchema: unknown,
  allowPersistentApproval: boolean,
): Record<string, unknown> {
  if (!requestedSchema || typeof requestedSchema !== 'object' || Array.isArray(requestedSchema)) {
    return {}
  }
  const properties = (requestedSchema as Record<string, unknown>).properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return {}
  if (!Object.prototype.hasOwnProperty.call(properties, 'allowPersistentApproval')) return {}
  return { allowPersistentApproval }
}

/** Build a TurnEventSink backed by the given shared state. push() also flips
 *  `done` when it observes a terminal event (turn_completed / error). */
function makeSink(state: SinkState): TurnEventSink {
  return {
    push(event) {
      state.queue.push(event)
      if (event.type === 'turn_completed' || event.type === 'error') {
        state.done = true
      }
      state.resolveWait?.()
    },
    close() {
      state.done = true
      state.resolveWait?.()
    },
    done() {
      return Promise.resolve()
    },
  }
}

// ---------------------------------------------------------------------------
// Session Fork: rollout 文件层面的会话复制（codex 没有 fork RPC）
//
// 下面三个函数只被 forkSession 用，export 是为了能单测——它们的正确性依赖对
// codex 磁盘格式的推断（UUID 版本位、日期目录用本地时间、session_meta 的形状），
// 而 forkSession 本身要写 ~/.codex 真实目录，不适合在测试里跑。
// ---------------------------------------------------------------------------

/**
 * 生成 UUIDv7（48 bit 毫秒时间戳前缀 + 随机位）。
 *
 * codex 自己发的 thread id 全是 v7，fork 出的新 id 保持同一格式，
 * 这样 codex 原生 UI 按 id 排序时新会话仍落在正确位置。
 * randomUUID() 是 v4（纯随机），会破坏这个顺序。
 */
export function uuidV7(now: Date): string {
  const bytes = randomBytes(16)
  const ms = BigInt(now.getTime())
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn)
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70 // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // variant 10
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

/**
 * 拼 rollout 文件路径：~/.codex/sessions/YYYY/MM/DD/rollout-<本地时间>-<threadId>.jsonl
 *
 * 注意日期目录和文件名里的时间戳都是**本地时间**（payload 里的 timestamp 才是 UTC）——
 * 实测 2026-01-31T11:46:14Z 的会话落在 2026/01/31/rollout-2026-01-31T19-46-14-…（UTC+8）。
 * 用 UTC 拼会在跨日的时段把文件放进错误的日期目录。
 */
export function codexRolloutPath(now: Date, threadId: string): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const [yyyy, mm, dd] = [now.getFullYear(), p(now.getMonth() + 1), p(now.getDate())]
  const stamp = `${yyyy}-${mm}-${dd}T${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`
  return join(
    homedir(),
    '.codex',
    'sessions',
    String(yyyy),
    mm,
    dd,
    `rollout-${stamp}-${threadId}.jsonl`,
  )
}

/**
 * 改写 rollout 首行的 session_meta：换 thread id + 更新时间戳，其余字段（cwd /
 * model_provider / base_instructions…）原样保留——它们决定 fork 出的会话跟原会话
 * 跑在同样的配置下。
 *
 * 首行不是预期的 session_meta（格式变了 / 文件损坏）时原样返回：宁可产出一个
 * 打不开的副本，也不要把一行乱七八糟的 JSON 塞进去污染 codex 的解析。
 */
export function rewriteSessionMetaLine(line: string, newThreadId: string, now: Date): string {
  try {
    const parsed = JSON.parse(line) as {
      type?: string
      timestamp?: string
      payload?: Record<string, unknown>
    }
    if (parsed.type !== 'session_meta' || !parsed.payload) return line
    const iso = now.toISOString()
    return JSON.stringify({
      ...parsed,
      timestamp: iso,
      payload: { ...parsed.payload, id: newThreadId, timestamp: iso },
    })
  } catch {
    return line
  }
}
