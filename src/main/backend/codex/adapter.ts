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

import { logger } from '@main/service/logger'
import {
  agentMessageDeltaParamsSchema,
  commandApprovalParamsSchema,
  fileChangeApprovalParamsSchema,
  itemCompletedParamsSchema,
  itemStartedParamsSchema,
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
  type ModelOption,
  type SessionSummary,
  type StartSessionArgs,
  type StartTurnArgs,
  type TurnEvent,
} from '@shared/backend/types'

import { type ProcessSpawner, RealProcessSpawner } from '../process-spawner'

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

  /** 当前 turn 的事件 sink（同一时刻只跑一个 turn） */
  private currentSink: TurnEventSink | null = null
  /** 内部 turnId → codex turnId 映射 */
  private turnIdMap = new Map<string, string>()

  constructor(opts: CodexAdapterOptions = {}) {
    this.opts = opts
    this.spawner = opts.spawner ?? new RealProcessSpawner()
  }

  // ============ 生命周期 ============

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (!this.proc) {
      const binary = this.opts.binaryPath ?? 'codex'
      this.proc = this.spawner.spawn({
        command: binary,
        args: ['app-server', '--listen', 'stdio://'],
        ...(this.opts.cwd !== undefined ? { cwd: this.opts.cwd } : {}),
      })
      this.proc.child.stdout?.on('data', (chunk: Buffer) => this.onStdoutData(chunk))
      this.proc.child.stderr?.on('data', (chunk: Buffer) => {
        log.warn('codex stderr:', chunk.toString('utf-8').trim())
      })
      this.proc.child.on('exit', (code, signal) => {
        log.warn('codex exited:', { code, signal })
        this.initialized = false
      })
    }

    // 发 initialize 握手
    await this.sendRequest('initialize', {
      clientInfo: { name: 'catmax-app', title: 'catmax', version: '0.1.0' },
    })
    // 通知 initialized
    this.sendNotification('initialized', {})
    this.initialized = true
    log.info('initialized')
  }

  async healthCheck(): Promise<{ ok: boolean; version?: string; error?: string }> {
    // 用 `codex --version` 检测可用性
    try {
      const { execSync } = await import('node:child_process')
      const binary = this.opts.binaryPath ?? 'codex'
      const output = execSync(`${binary} --version`, {
        encoding: 'utf-8',
        timeout: 5000,
      })
      return { ok: true, version: output.trim() }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      return {
        ok: false,
        error: code === 'ENOENT' ? 'not-installed' : 'spawn-failed',
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.proc) {
      this.proc.kill('SIGTERM')
      this.proc = null
    }
    this.initialized = false
    this.pendingRequests.clear()
    this.pendingApprovals.clear()
    log.info('disposed')
  }

  getCapabilities(): BackendCapabilities {
    return this.capabilities
  }

  async listModels(): Promise<ModelOption[]> {
    // 调 codex 的 model/list
    try {
      await this.ensureInitialized()
      const result = await this.sendRequest('model/list', {})
      const data =
        (
          result as {
            models?: Array<{ id: string; display_name?: string; hidden?: boolean }>
          }
        ).models ?? []
      return data
        .filter((m) => !m.hidden)
        .map((m) => ({
          id: m.id,
          displayName: m.display_name ?? m.id,
        }))
    } catch (e) {
      log.warn('listModels failed, returning defaults:', e)
      // 回退默认
      return [
        { id: 'gpt-5.1-codex', displayName: 'GPT-5.1 Codex', isDefault: true },
        { id: 'gpt-5', displayName: 'GPT-5' },
      ]
    }
  }

  // ============ 会话 ============

  async startSession(
    args: StartSessionArgs,
  ): Promise<{ sessionId: string; backendThreadId: string }> {
    await this.ensureInitialized()
    const result = await this.sendRequest('thread/start', {
      cwd: args.cwd,
      ...(args.model !== undefined ? { model: args.model } : {}),
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

  async resumeSession(backendThreadId: string): Promise<{ messages: never[] }> {
    await this.ensureInitialized()
    await this.sendRequest('thread/resume', { threadId: backendThreadId })
    // TODO Plan 3+: 把 codex 返回的 items 转成 NormalizedMessage[]
    // MVP 阶段先返回空（用户重开历史会话时显示空，能继续聊）
    return { messages: [] }
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
      const turnResponse = await this.sendRequest('turn/start', {
        threadId: args.sessionId,
        input: args.prompt,
        ...(args.model !== undefined ? { model: args.model } : {}),
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
      while (true) {
        while (state.queue.length > 0) {
          const event = state.queue.shift()!
          yield event
          if (event.type === 'turn_completed' || event.type === 'error') {
            return
          }
        }
        if (state.done) return
        await new Promise<void>((resolve) => {
          state.resolveWait = resolve
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
    await this.sendRequest('turn/steer', { turnId: codexTurnId, input: prompt })
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
