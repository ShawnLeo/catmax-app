/**
 * CodexAdapter —— codex app-server 的 AgentBackend 实现。
 *
 * 生命周期：
 *   1. initialize() —— spawn codex app-server 子进程，发 initialize 请求握手
 *   2. startSession() —— 调 thread/start 创建一个 codex thread
 *   3. startTurn() —— 调 turn/start，订阅 item/* 事件流，yield 为 TurnEvent
 *   4. interrupt() —— 调 turn/interrupt
 *   5. respondApproval() —— 响应 item/commandExecution/requestApproval
 *   6. dispose() —— kill 子进程
 *
 * 关键设计：
 * - turnId 是 App 内部生成（UUID），Adapter 内部维护 turnId → codex turn id 映射
 * - AsyncIterable<TurnEvent> 作为 startTurn 输出契约
 * - codex 协议细节（item 类型、approval 流程）在这里全部转译为 TurnEvent
 */
import { randomUUID } from 'node:crypto'
import { readdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { logger } from '@main/service/logger'
import {
  agentMessageDeltaParamsSchema,
  commandApprovalParamsSchema,
  fileChangeApprovalParamsSchema,
  itemCompletedParamsSchema,
  itemStartedParamsSchema,
  modelListResultSchema,
  turnCompletedParamsSchema,
  turnStartedParamsSchema,
  type CodexItem,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '@shared/backend/schema'
import {
  BackendError,
  type AgentBackend,
  type ApprovalDecision,
  type BackendCapabilities,
  type EffortLevel,
  type ModelOption,
  type NormalizedMessage,
  type SessionSummary,
  type StartSessionArgs,
  type StartTurnArgs,
  type TurnEvent,
} from '@shared/backend/types'

import { checkCliHealth } from '../health-check'
import { type ProcessSpawner, RealProcessSpawner } from '../process-spawner'

import {
  codexTurnsToMessages,
  extractTurns,
  mergeAssistantAndToolMessages,
} from './history-mapping'
import {
  codexApprovalToRequest,
  codexCommandToOutput,
  codexFileChangeToOutput,
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

const log = logger.domain('codex-adapter')

// z.union with passthrough fallback means `switch (item.type)` does NOT narrow
// item fields. We extract the variants explicitly (same pattern as mapping.ts).
type CommandExecutionItem = Extract<CodexItem, { type: 'command_execution' }>
type FileChangeItem = Extract<CodexItem, { type: 'file_change' }>

/** 事件 sink —— 给测试用，可以注入自定义收集器 */
export interface TurnEventSink {
  push(event: TurnEvent): void
  close(): void
  /** 等待流结束（turn_completed 或 error） */
  done(): Promise<void>
}

export interface CodexAdapterOptions {
  /** codex 可执行文件路径（默认从 PATH 找） */
  binaryPath?: string
  /** 自定义 spawner（测试用） */
  spawner?: ProcessSpawner
  /** 自定义 cwd（默认 process.cwd） */
  cwd?: string
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

export class CodexAdapter implements AgentBackend {
  readonly id = 'codex' as const

  readonly capabilities: BackendCapabilities = {
    supportsInterrupt: true,
    supportsApproval: true,
    supportsSteer: true,
    supportsThreadFork: true,
    supportsModelSelection: true,
    supportsEffort: true,
    supportsPermissionMode: true,
    supportedPermissionModes: [
      'default',
      'acceptEdits',
      'auto',
      'plan',
      'dontAsk',
      'bypassPermissions',
    ],
    supportedEfforts: ['low', 'medium', 'high'],
    supportsHotSwap: false,
  }

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
   * model/list 缓存——避免每次 listModels() 都 RPC 往返。
   * 存的是 Promise（而不是已 resolve 的值），这样并发调用者共享同一次 RPC：
   *   - initialize() 预取 + 第一次 listModels() 同时触发时，只发一次 model/list
   *   - 失败时把缓存清空（设回 null），下次调用会重试
   * 进程退出时也清空（账户可能换了）。
   */
  private cachedModelsPromise: Promise<ModelOption[]> | null = null

  /** 当前 turn 的事件 sink（同一时刻只跑一个 turn） */
  private currentSink: TurnEventSink | null = null
  /** 内部 turnId → codex turnId 映射 */
  private turnIdMap = new Map<string, string>()

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

  // ============ 生命周期 ============

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (!this.proc) {
      const binary = this.opts.binaryPath ?? 'codex'
      // codex 0.93+ 的 app-server 默认就是 stdio，不需要 `--listen stdio://`。
      // 旧版本（codex 0.x 早期）才有 --listen 参数。新版带上反而报错：
      //   error: unexpected argument '--listen' found
      // 这里不带，让两边都兼容（旧版默认行为也是 stdio）。
      // 同时注入 extraEnv（HTTPS_PROXY 等代理环境变量）——由 BackendManager.applySettings 设置。
      this.proc = this.spawner.spawn({
        command: binary,
        args: ['app-server'],
        env: { ...this.extraEnv },
        ...(this.opts.cwd !== undefined ? { cwd: this.opts.cwd } : {}),
      })
      this.proc.child.stdout?.on('data', (chunk: Buffer) => this.onStdoutData(chunk))
      this.proc.child.stderr?.on('data', (chunk: Buffer) => {
        // codex 的 stderr 带 ANSI 控制字符（颜色），先剥掉再处理
        const rawText = chunk.toString('utf-8').trim()
        const text = rawText.replace(/\x1B\[[0-9;]*m/g, '')
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
      this.proc.child.on('exit', (code, signal) => {
        log.warn('codex exited:', { code, signal })
        this.initialized = false
        // 进程死了，缓存的 model 列表也可能过时（比如用户重新登录了别的账户）——清掉。
        this.cachedModelsPromise = null
        // 进程死了，pending 的 request 全 reject（避免 30s 超时白等）
        this.rejectAllPending('codex process exited')
      })
    }

    // 发 initialize 握手
    try {
      await this.sendRequest('initialize', {
        clientInfo: { name: 'catmax-app', title: 'catmax', version: '0.1.0' },
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
    this.pendingRequests.clear()
    this.pendingApprovals.clear()
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
    const result = await this.sendRequest('thread/start', {
      cwd: args.cwd,
      model,
      approvalPolicy: permissionToApproval(args.permissionMode),
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
    const result = await this.sendRequest('thread/list', { cwd })
    const data = (result as { threads?: Array<Record<string, unknown>> }).threads ?? []
    return data.map((t) => ({
      backendThreadId: (t.id as string) ?? '',
      title: (t.preview as string) ?? null,
      lastActiveAt: (t.updatedAt as number) ?? Date.now(),
      model: (t.modelProvider as string) ?? null,
    }))
  }

  async deleteSession(backendThreadId: string): Promise<void> {
    // codex CLI 当前没有暴露 thread 删除 RPC——按文件名扫 rollout 文件删。
    // 文件路径：~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl
    // threadId 是 UUID，跨所有日期目录 glob `**/rollout-*-${threadId}.jsonl`。
    // 失败仅日志不抛——DB tombstone 兜底。
    const sessionsDir = join(homedir(), '.codex', 'sessions')
    try {
      // recursive: true 需要 Node 18.17+，catmax 要求 Node 22
      const entries = await readdir(sessionsDir, { recursive: true, withFileTypes: true })
      const suffix = `-${backendThreadId}.jsonl`
      const matches = entries.filter(
        (e) => e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith(suffix),
      )
      if (matches.length === 0) {
        log.warn('no codex rollout file found for thread', backendThreadId)
        return
      }
      for (const ent of matches) {
        // ent.path 是父目录（Node readdir withFileTypes 提供）
        const abs = join((ent as { path: string }).path ?? sessionsDir, ent.name)
        await unlink(abs).catch(() => {})
        log.info('deleted codex rollout file', abs)
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return // sessions 目录不存在，幂等
      log.warn('failed to delete codex session files', backendThreadId, e)
    }
  }

  async resumeSession(backendThreadId: string): Promise<{ messages: never[] }> {
    await this.ensureInitialized()
    await this.sendRequest('thread/resume', { threadId: backendThreadId })
    // TODO Plan 3+: 把 codex 返回的 items 转成 NormalizedMessage[]
    // MVP 阶段先返回空（用户重开历史会话时显示空，能继续聊）
    return { messages: [] }
  }

  /** 读会话历史：调 thread/read 拿 turn 数组，转成 NormalizedMessage[] */
  async getHistory(
    backendThreadId: string,
    cwd?: string,
  ): Promise<{ messages: NormalizedMessage[]; aiTitle?: string | null }> {
    void cwd // codex 是 long-running app-server，cwd 在 thread/start 时已绑定，这里不用
    await this.ensureInitialized()
    const result = await this.sendRequest('thread/read', {
      threadId: backendThreadId,
      includeTurns: true,
    })
    const turns = extractTurns(result)
    const messages = codexTurnsToMessages(turns)
    const merged = mergeAssistantAndToolMessages(messages)
    log.info('history loaded', backendThreadId, merged.length, 'messages')
    return { messages: merged }
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
    const state: SinkState = { queue: [], resolveWait: null, done: false }
    this.currentSink = makeSink(state)

    try {
      // args.sessionId 实际是 backendThreadId（startSession 返回的）
      // codex 0.93+ 的 turn/start 把 input 从 string 改成了 UserInput[] 数组：
      //   旧版: input: "用户文本"
      //   新版: input: [{ type: "text", text: "用户文本" }]
      // 不改的话 codex 报 "Invalid request: invalid type: string ..., expected a sequence"。
      // 同时 model 也是必需的（同 thread/start），用户没选时用 listModels 返回的默认。
      const model = args.model ?? (await this.resolveDefaultModel())
      // effort='none' 时产生零 reasoning token——codex 是两端里唯一能真正"关闭思考"的后端。
      // effort 字段 schema 是 z.string().optional()，'none' 合法。
      const turnResponse = await this.sendRequest('turn/start', {
        threadId: args.sessionId,
        input: [{ type: 'text', text: args.prompt }],
        model,
        ...(args.effort !== undefined ? { effort: args.effort } : {}),
        approvalPolicy: permissionToApproval(args.permissionMode),
      })
      const codexTurnId = (turnResponse as { turn?: { id?: string } }).turn?.id
      if (codexTurnId) {
        this.turnIdMap.set(internalTurnId, codexTurnId)
      }
    } catch (e) {
      this.currentSink = null
      this.turnIdMap.delete(internalTurnId)
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
    }
  }

  // ============ 反向控制 ============

  async interrupt(turnId: string): Promise<void> {
    const codexTurnId = this.turnIdMap.get(turnId)
    if (!codexTurnId) {
      log.warn('interrupt: no codex turn id for', turnId)
      return
    }
    try {
      await this.sendRequest('turn/interrupt', { turnId: codexTurnId })
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
      pending.reject(new Error(msg.error.message))
    } else {
      pending.resolve(msg.result)
    }
  }

  private handleNotification(msg: JsonRpcNotification): void {
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
        this.turnIdMap.set(internalTurnId, codexTurnId)
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
    const itemId = ensureItemId(item.id, randomUUID())
    // codexItemSchema is z.union with passthrough fallback — switch on type does
    // NOT narrow item. Cast explicitly to the extracted variant (see mapping.ts).
    if (item.type === 'command_execution') {
      const cmd = item as CommandExecutionItem
      return {
        type: 'tool_call_completed',
        turnId,
        itemId,
        output: codexCommandToOutput(cmd),
      }
    }
    if (item.type === 'file_change') {
      const fc = item as FileChangeItem
      return {
        type: 'tool_call_completed',
        turnId,
        itemId,
        output: codexFileChangeToOutput(fc),
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

  private findCurrentTurnId(): string | null {
    // 简化：取 turnIdMap 第一个 entry（同时只跑一个 turn）
    for (const [internal] of this.turnIdMap) {
      return internal
    }
    return null
  }
}

/** 把 PermissionMode 翻译成 codex 的 approvalPolicy */
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
function permissionToApproval(mode?: string): string | undefined {
  switch (mode) {
    case 'default':
      return 'untrusted'
    case 'acceptEdits':
      return 'on-failure'
    case 'auto':
      return 'on-failure'
    case 'plan':
      return 'never'
    case 'dontAsk':
      return 'never'
    case 'bypassPermissions':
      return 'never'
    default:
      return undefined
  }
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
