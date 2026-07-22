/**
 * ClaudeAdapter —— claude CLI 的 AgentBackend 实现。
 *
 * 和 codex 不同：
 * - 每次 turn 启动一个新 claude 进程（不是长连接）
 * - 用 --resume <session_id> 续接会话
 * - 没有反向 approval 请求（permission-mode 自动决策）
 * - 中断 = kill 进程
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { logger } from '@main/service/logger'
import {
  type AssistantMessage,
  type ResultMessage,
  type StreamEventMessage,
} from '@shared/backend/claude-schema'
import {
  BackendError,
  type AgentBackend,
  type ApprovalDecision,
  type BackendCapabilities,
  type ModelOption,
  type NormalizedMessage,
  type SessionSummary,
  type StartSessionArgs,
  type StartTurnArgs,
  type TurnEvent,
} from '@shared/backend/types'
import { app } from 'electron'

import { checkCliHealth } from '../health-check'
import { type ProcessSpawner, RealProcessSpawner } from '../process-spawner'

import { ApprovalBridge, type BridgePermissionRequest } from './approval-bridge'
import {
  listClaudeSessionsFromDisk,
  readHistoryFromJsonl,
  resolveSessionJsonlPath,
} from './jsonl-reader'
import {
  StreamEventAggregator,
  assistantToEvents,
  claudePermissionToApprovalRequest,
  resultToEvent,
  userToolResultToEvents,
} from './mapping'
// MCP server 脚本路径——electron-vite 编译时把 `?modulePath` 后缀替换成打包后的绝对路径
// （dev: out/main/mcp-server.js，packaged: app.asar 内的对应路径）。
// 注意：server.ts 是独立入口（在 electron.vite.config.ts 的 rollupOptions.input 配置），
// 不能 import 这个文件的内容（会拉到 main bundle），只能拿路径字符串。
import mcpServerScriptPath from './mcp/server?modulePath'
import { encodeUserMessage, LineBuffer, parseClaudeLine } from './protocol'

const log = logger.domain('claude-adapter')

/**
 * per-turn 上下文——支持多 turn 并发隔离。
 *
 * 每个字段都属于"当前 turn"独立状态，多个并发 turn 各持一份，互不串台。
 * 由 startTurn 创建、generator finally 块（或 interrupt / dispose）清理。
 */
interface TurnContext {
  /** claude 子进程 */
  proc: ReturnType<ProcessSpawner['spawn']>
  /** ApprovalBridge——MCP server 子进程通过 socket 连进来 */
  bridge: ApprovalBridge
  /** 临时 mcp-config JSON 文件路径——turn 结束时删 */
  mcpConfigPath: string
  /** 事件队列——stdout data 回调和 handlePermissionRequest 都 push 进来 */
  queue: TurnEvent[]
  /** generator 主循环的 resolve——push 事件后调它唤醒等待 */
  resolveWait: (() => void) | null
  /** per-turn 的审批 Map——key 是 `${turnId}:${bridgeRequestId}` */
  pendingApprovals: Map<
    string,
    {
      resolve: (action: ApprovalDecision['action']) => void
      bridgeRequestId: number
      originalInput: Record<string, unknown>
    }
  >
}

export interface ClaudeAdapterOptions {
  binaryPath?: string
  spawner?: ProcessSpawner
  cwd?: string
  /**
   * 当 claude 在 system.init 返回真实 session_id 时触发（参数：internalId, realId）。
   * manager 注入此回调，把 db 里 session.backend_thread_id 从占位 UUID 更新成真实 id，
   * 让用户重启应用后仍能 --resume 加载历史。
   */
  onRealSessionId?: (internalId: string, realSessionId: string) => void
}

export class ClaudeAdapter implements AgentBackend {
  readonly id = 'claude' as const

  readonly capabilities: BackendCapabilities = {
    supportsInterrupt: true,
    // 通过内置 MCP server + --permission-prompt-tool 实现：
    // claude spawn 时把权限决策委托给 mcp__catmax__approve 工具，
    // MCP server 子进程 → Unix socket → main → IPC → renderer 弹 ClaudePermissionDialog。
    supportsApproval: true,
    supportsSteer: false,
    supportsThreadFork: false,
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
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  }

  private opts: ClaudeAdapterOptions
  private spawner: ProcessSpawner

  /**
   * per-turn 上下文——支持多 turn 并发（用户切到 session B 时 A 的 turn 还在跑）。
   *
   * 每个 turn 有自己独立的：
   * - proc（claude 子进程）
   * - bridge（ApprovalBridge，独立的 socket + token）
   * - mcpConfigPath（临时 mcp-config JSON 文件）
   * - queue / resolveWait（事件队列 + generator 唤醒）
   * - pendingApprovals（per-turn 的审批 Map）
   *
   * interrupt / respondApproval 用 turnId 精确定位 context，不会误伤其他 turn。
   */
  private turnContexts = new Map<string, TurnContext>()

  /** internal session id → claude session id 反向映射 */
  private sessionIdMap = new Map<string, string>()
  /**
   * internal session id → 是否已经拿到 claude 分配的真实 session_id。
   * 全新会话（startSession 时建的）第一次 turn 时 claude 还没分配 id，必须
   * 不带 --resume 启动；拿到 system.init 的 session_id 后标记 true，后续才能 --resume。
   * Bug D：之前一律 --resume 一个随机 UUID，claude 找不到会话就立刻 stderr 报错退出，
   * stdout 只吐一条 is_error result，UI 拿不到流式响应。
   */
  private resumableSessions = new Set<string>()

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.opts = opts
    this.spawner = opts.spawner ?? new RealProcessSpawner()
  }

  /** 运行时设置 binaryPath（settings 加载后注入） */
  setBinaryPath(path: string): void {
    this.opts = { ...this.opts, binaryPath: path }
  }

  /** 注入额外的子进程环境变量（HTTPS_PROXY 等）——每次 turn spawn 时带上 */
  setExtraEnv(env: Record<string, string>): void {
    this.extraEnv = env
  }
  private extraEnv: Record<string, string> = {}

  async initialize(): Promise<void> {
    // claude 不需要预初始化——每次 turn 启动新进程
    log.info('initialized (lazy, per-turn)')
  }

  async healthCheck(): Promise<{ ok: boolean; version?: string; error?: string }> {
    const binary = this.opts.binaryPath ?? 'claude'
    return checkCliHealth(binary, ['--version'])
  }

  async dispose(): Promise<void> {
    // 清理所有还在跑的 turn——app 退出 / backend 切换时调
    const turnIds = Array.from(this.turnContexts.keys())
    await Promise.all(turnIds.map((id) => this.interrupt(id)))
    log.info('disposed,', turnIds.length, 'turns cleaned')
  }

  getCapabilities(): BackendCapabilities {
    return this.capabilities
  }

  async listModels(): Promise<ModelOption[]> {
    // claude 不像 codex 那样有 model/list，返回固定的常用模型
    return [
      { id: 'sonnet', displayName: 'Claude Sonnet (latest)', isDefault: true },
      { id: 'opus', displayName: 'Claude Opus (latest)' },
      { id: 'haiku', displayName: 'Claude Haiku (latest)' },
    ]
  }

  async startSession(
    args: StartSessionArgs,
  ): Promise<{ sessionId: string; backendThreadId: string }> {
    // claude session 是进程级的，不预创建。生成 App 内部 id 即可。
    const sessionId = randomUUID()
    // backendThreadId 等于 sessionId（claude 第一次 turn 时会返回真实 session_id，我们记下映射）
    this.sessionIdMap.set(sessionId, sessionId) // 临时占位，第一次 turn 后更新
    void args
    return {
      sessionId,
      backendThreadId: sessionId,
    }
  }

  async listSessions(cwd?: string): Promise<SessionSummary[]> {
    // 扫磁盘枚举 ~/.claude/projects/<encoded-cwd>/*.jsonl。
    // - 传 cwd：只扫单个项目目录（reconcile 用）
    // - 不传 cwd：扫所有项目目录（「扫描导入」全盘模式用）
    // 之前直接返回 [] 是 MVP 阶段没做，现在能扫了——jsonl 文件就是事实来源。
    return listClaudeSessionsFromDisk(cwd)
  }

  async deleteSession(backendThreadId: string, cwd?: string): Promise<void> {
    // 删 ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl 文件。
    // 复用 resolveSessionJsonlPath（jsonl-reader 里的路径推算逻辑）。
    // 失败仅日志不抛——DB tombstone 会兜底，reconcile 不会再把这条登记回来。
    const filePath = resolveSessionJsonlPath(backendThreadId, cwd)
    try {
      await unlink(filePath)
      log.info('deleted claude session file', filePath)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return // 文件已不存在，幂等
      log.warn('failed to delete claude session file', filePath, e)
    }
  }

  async resumeSession(backendThreadId: string): Promise<{ messages: never[] }> {
    // 不需要主动 resume——下次 startTurn 会用 --resume
    void backendThreadId
    return { messages: [] }
  }

  /**
   * 读会话历史：直接读 ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl 文件。
   *
   * 为什么不 spawn `claude --resume <id>` 读 stdout：
   * - `--resume` 不带 stdin 时 claude 报错 "No deferred tool marker found" 退出
   * - 即便带上 prompt 也会消耗 token + 起一个新 turn，副作用太大
   * - jsonl 文件就是 claude 自己的持久化格式，包含完整历史 + aiTitle
   *
   * cwd 必须传——claude 把历史文件按 cwd 分目录存。
   *
   * 找不到文件时抛错（不静默返空）——让 UI 能提示用户。
   */
  async getHistory(
    backendThreadId: string,
    cwd?: string,
  ): Promise<{ messages: NormalizedMessage[]; aiTitle?: string | null }> {
    const spawnCwd = cwd ?? this.opts.cwd
    const result = await readHistoryFromJsonl(backendThreadId, spawnCwd)
    if (result === null) {
      throw new BackendError(
        'protocol',
        `claude getHistory(${backendThreadId}, cwd=${spawnCwd ?? '<inherit>'}): session jsonl not found`,
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

  async *startTurn(args: StartTurnArgs): AsyncIterable<TurnEvent> {
    const internalTurnId = randomUUID()
    yield { type: 'turn_started', turnId: internalTurnId, sessionId: args.sessionId }

    // 找 claude session_id
    const claudeSessionId = this.sessionIdMap.get(args.sessionId) ?? args.sessionId
    // 只有已经拿到 claude 真实 session_id 的会话才能 --resume。
    // 新建会话（startSession 建的占位 id）第一次 turn 必须不带 --resume——
    // 让 claude 自己分配 session_id，从 system.init 里读到后存映射 + 标记可续接。
    //
    // ⚠️ 重启恢复场景：用户从历史加载一个已有会话续聊时，内存里的 resumableSessions
    // 是空的（进程刚起），但磁盘上的 .jsonl 文件存在——文件名就是 claude 真实
    // session_id（onRealSessionId 写回 db 的就是它）。所以除了查内存 Set，还要查
    // 磁盘：jsonl 存在 → 这就是真实 session_id，可以 --resume。
    // 不补这个判定的话，历史会话续聊会走"新建会话"分支（不带 --resume），
    // claude 会分配新的 session_id → 看起来像"多出来一个会话"（Bug）。
    let canResume = this.resumableSessions.has(args.sessionId)
    if (!canResume && args.cwd) {
      const jsonlPath = resolveSessionJsonlPath(args.sessionId, args.cwd)
      if (existsSync(jsonlPath)) {
        // 磁盘有 jsonl → args.sessionId 就是 claude 真实 session_id
        this.sessionIdMap.set(args.sessionId, args.sessionId)
        this.resumableSessions.add(args.sessionId)
        canResume = true
        log.info('resumable from disk (process restarted)', args.sessionId, 'jsonl=', jsonlPath)
      }
    }

    // 启动 claude 进程
    const binary = this.opts.binaryPath ?? 'claude'
    const procArgs = [
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      // 开启真正的逐 token 流式输出（默认 claude 是按 message 整块输出，不是流式）。
      // 加了这个 flag 后，stdout 会多出 stream_event 类型的消息，每个 token 增量一条。
      // Bug G：之前没加这个 flag，UI 看到的是"等全部响应完成才一次性渲染"。
      '--include-partial-messages',
    ]
    if (canResume) {
      procArgs.push('--resume', claudeSessionId)
    }
    if (args.model) {
      procArgs.push('--model', args.model)
    }
    // effort='none'：claude CLI 没有 --thinking off（--help 实测无此 flag，
    // --thinking adaptive / --max-thinking-tokens 是 Agent SDK 参数，不是 CLI 的），
    // 只能映射到 --effort low 把 reasoning 压到最低档（非真正关闭）。
    // 其他档位 low/medium/high/xhigh/max 原样透传。
    if (args.effort) {
      procArgs.push('--effort', args.effort === 'none' ? 'low' : args.effort)
    }
    if (args.permissionMode) {
      procArgs.push('--permission-mode', args.permissionMode)
    }

    // ============ 启动 ApprovalBridge + 配置 mcp-config + 加 permission-prompt-tool flags ============
    // 这一块是 claude 权限交互的核心机制：
    // - ApprovalBridge：一个 Unix socket server，等 MCP server 子进程连进来
    // - mcp-config：告诉 claude spawn 哪个 MCP server（我们内置的 catmax MCP）
    // - --permission-prompt-tool：claude 把权限决策委托给 mcp__catmax__approve
    //
    // 注意：MCP server 子进程由 claude 自己 spawn（不是我们 spawn），生命周期跟 claude 进程绑定。
    // 我们只负责起 socket server + 写 mcp-config + 加 flags，剩下交给 claude。
    const userData = app.getPath('userData')
    const socketPath = join(userData, `catmax-claude-${internalTurnId}.sock`)
    const bridgeToken = randomUUID()

    // 创建 per-turn 上下文（在 bridge 创建前就放到 map，让 handlePermissionRequest 能找到）
    const ctx: TurnContext = {
      proc: undefined as unknown as TurnContext['proc'], // 先占位，spawn 后填
      bridge: undefined as unknown as ApprovalBridge, // 先占位，下面立即填
      mcpConfigPath: '', // 下面填
      queue: [],
      resolveWait: null,
      pendingApprovals: new Map(),
    }
    this.turnContexts.set(internalTurnId, ctx)

    ctx.bridge = new ApprovalBridge({
      socketPath,
      token: bridgeToken,
      turnId: internalTurnId,
      onRequest: (req) => this.handlePermissionRequest(req, internalTurnId),
      onDisconnect: () => {
        // bridge 断开意味着 MCP server 退出 → claude 进程也快退了
        // 把当前 turn 的 pendingApprovals 全部 reject，让 promise 不会永远 hang
        for (const [id, pending] of ctx.pendingApprovals) {
          log.info('bridge disconnected, rejecting pending approval', id)
          pending.resolve('reject')
          ctx.pendingApprovals.delete(id)
        }
      },
    })
    await ctx.bridge.start()

    const mcpConfig = {
      mcpServers: {
        catmax: {
          type: 'stdio',
          // Electron 当 Node 用（ELECTRON_RUN_AS_NODE=1）——避免启动整个 Electron
          command: process.execPath,
          args: [mcpServerScriptPath],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
            CATMAX_APPROVAL_SOCKET: socketPath,
            CATMAX_APPROVAL_TOKEN: bridgeToken,
          },
        },
      },
    }
    const mcpConfigPath = join(userData, `catmax-mcp-${internalTurnId}.json`)
    ctx.mcpConfigPath = mcpConfigPath
    await writeFile(mcpConfigPath, JSON.stringify(mcpConfig), 'utf8')

    procArgs.push('--strict-mcp-config', '--mcp-config', mcpConfigPath)
    procArgs.push('--permission-prompt-tool', 'mcp__catmax__approve')

    // spawn cwd 优先级：调用方传入（args.cwd）> adapter opts > undefined（继承 main 进程 cwd）
    // Bug E-1：claude 是 per-turn process 模型，每次 turn 都要 spawn 新进程——
    // cwd 必须正确，否则文件工具和历史文件都会落到错误目录。
    const spawnCwd = args.cwd ?? this.opts.cwd
    const proc = this.spawner.spawn({
      command: binary,
      args: procArgs,
      // 注入代理 env（claude 调 Anthropic API 时用得到）
      env: { ...this.extraEnv },
      ...(spawnCwd !== undefined ? { cwd: spawnCwd } : {}),
    })
    ctx.proc = proc

    // 写用户消息到 stdin 并 close（claude 一次只处理一条 user 消息）
    proc.write(encodeUserMessage(args.prompt) + '\n')
    proc.endInput()

    // 读 stdout 流，转 TurnEvent。
    // queue / resolveWait 用 ctx（per-turn context）——多 turn 并发时各自独立。
    const queue: TurnEvent[] = ctx.queue
    let resolveWait: (() => void) | null = null
    ctx.resolveWait = null
    let done = false
    const lineBuffer = new LineBuffer()
    // 流式事件聚合器：处理 --include-partial-messages 模式下的 stream_event
    const aggregator = new StreamEventAggregator(internalTurnId)
    // 跟踪是否见过 stream_event —— 如果见过，最终的完整 assistant 消息就忽略
    // （因为 aggregator 已经把每个 token 推给 UI 了，再处理完整块会重复显示）
    let sawStreamEvents = false

    /** helper：push 一个事件到队列，并唤醒 generator 主循环 */
    const pushEvent = (event: TurnEvent): void => {
      queue.push(event)
      ctx.resolveWait?.()
      resolveWait?.()
    }

    const onChunk = (chunk: Buffer): void => {
      const lines = lineBuffer.push(chunk)
      for (const line of lines) {
        const msg = parseClaudeLine(line)
        if (!msg) continue
        if (msg.type === 'system') {
          // 记下 claude 真实 session_id，并标记此会话可续接（下次 turn 可以 --resume）
          if (msg.session_id) {
            this.sessionIdMap.set(args.sessionId, msg.session_id)
            this.resumableSessions.add(args.sessionId)
            log.info('claude assigned session_id', msg.session_id, 'for internal', args.sessionId)
            // 通知 manager 把真实 id 回写 db——重启后才能 --resume 加载历史
            try {
              this.opts.onRealSessionId?.(args.sessionId, msg.session_id)
            } catch (e) {
              log.warn('onRealSessionId callback failed:', e)
            }
          }
          continue
        }
        if (msg.type === 'stream_event') {
          // 真正的逐 token 流式 —— Bug G
          sawStreamEvents = true
          for (const event of aggregator.push(msg as StreamEventMessage)) {
            pushEvent(event)
            // AskUserQuestion 特殊：tool_call_started 带 askUserQuestion 字段时，
            // 额外推一条 ask_user_question 事件给 UI 弹 dialog。
            // 不在 mapping 里直接推是为了保持 mapping 纯粹（一进一出）。
            if (event.type === 'tool_call_started' && event.askUserQuestion) {
              pushEvent({
                type: 'ask_user_question',
                turnId: internalTurnId,
                requestId: event.itemId, // 用 tool_use_id 作 requestId（一对一）
                toolUseId: event.itemId,
                questions: event.askUserQuestion.questions,
              })
            }
          }
          continue
        }
        if (msg.type === 'assistant') {
          // 如果已经流式推送过（sawStreamEvents=true），最终的完整 assistant 消息忽略，
          // 避免重复。否则（没开 --include-partial-messages 时）才用完整块。
          if (sawStreamEvents) continue
          for (const event of assistantToEvents(msg as AssistantMessage, internalTurnId)) {
            pushEvent(event)
            // 同 stream_event 路径——AskUserQuestion tool_use 额外推 ask_user_question
            if (event.type === 'tool_call_started' && event.askUserQuestion) {
              pushEvent({
                type: 'ask_user_question',
                turnId: internalTurnId,
                requestId: event.itemId,
                toolUseId: event.itemId,
                questions: event.askUserQuestion.questions,
              })
            }
          }
          continue
        }
        if (msg.type === 'user') {
          for (const event of userToolResultToEvents(msg, internalTurnId)) {
            pushEvent(event)
          }
          continue
        }
        if (msg.type === 'result') {
          const resultMsg = msg as ResultMessage
          // 收尾：把还没收到 content_block_stop 的 tool_use 兜底发出
          if (sawStreamEvents) {
            for (const event of aggregator.flushPendingToolUse()) {
              pushEvent(event)
            }
          }
          // Bug D-2：is_error 的 result 必须先推 error event，把 claude 报的错暴露给 UI。
          // 否则用户只看到「消息发出但没响应」——turn_completed('error') 不会带可读消息。
          if (resultMsg.is_error) {
            const errText =
              (Array.isArray(resultMsg.errors) && resultMsg.errors.length > 0
                ? resultMsg.errors.join('; ')
                : undefined) ?? 'claude turn ended with error (no detail)'
            pushEvent({
              type: 'error',
              turnId: internalTurnId,
              message: errText,
              recoverable: false,
            })
          }
          pushEvent(resultToEvent(resultMsg, internalTurnId))
          done = true
        }
      }
    }

    proc.child.stdout?.on('data', onChunk)
    proc.child.on('exit', () => {
      done = true
      resolveWait?.()
      ctx.resolveWait?.()
    })

    try {
      while (!done || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resolveWait = resolve
            ctx.resolveWait = resolve
          })
          resolveWait = null
          ctx.resolveWait = null
        }
        while (queue.length > 0) {
          const event = queue.shift()!
          yield event
          // 只有 turn_completed 终结 generator——error 事件后我们仍想 yield 跟在
          // 后面的 turn_completed（Bug D-2：error event 先 yield，紧接 turn_completed）。
          if (event.type === 'turn_completed') {
            return
          }
        }
      }
    } finally {
      // 清理当前 turn 的 context——多 turn 并发时只清自己的，不影响其他 turn
      await this.cleanupTurnContext(internalTurnId)
    }
  }

  /**
   * 清理单个 turn 的 context：
   * - stop bridge（关 socket server，删 socket 文件）
   * - unlink mcp-config 临时文件
   * - reject 所有 pendingApprovals（防止 promise 永远 hang）
   * - 从 turnContexts 里 delete
   *
   * 由 generator finally 块（turn 正常结束 / interrupt / generator 抛错）调用。
   * interrupt 也单独调用，会先 delete turnContexts 让 finally 块的 cleanup 变 no-op。
   */
  private async cleanupTurnContext(turnId: string): Promise<void> {
    const ctx = this.turnContexts.get(turnId)
    if (!ctx) return // 已经被 interrupt 清理过，no-op
    this.turnContexts.delete(turnId)
    // reject 所有未完成的 pendingApprovals
    for (const [, pending] of ctx.pendingApprovals) {
      pending.resolve('reject')
    }
    ctx.pendingApprovals.clear()
    try {
      await ctx.bridge.stop()
    } catch (e) {
      log.warn('bridge stop failed:', e)
    }
    if (ctx.mcpConfigPath) {
      try {
        await unlink(ctx.mcpConfigPath)
      } catch {
        // 文件可能不存在（turn 启动失败时），忽略
      }
    }
  }

  /**
   * ApprovalBridge 收到 MCP server 转发上来的权限请求时触发。
   *
   * 流程：
   * 1. 把请求转成 ApprovalRequest（复用 mapping 层的 claudePermissionToApprovalRequest）
   * 2. push approval_requested TurnEvent 到当前 turn 的队列
   * 3. 挂一个 promise，等 respondApproval 调用
   * 4. promise 完成后把决策写回 bridge → MCP server → claude
   *
   * requestId 用 `${turnId}:${bridgeRequestId}` 复合形式——确保多 turn 并发时
   * 各自从 1 开始递增的 bridgeRequestId 不会撞。
   */
  private handlePermissionRequest(req: BridgePermissionRequest, turnId: string): void {
    const ctx = this.turnContexts.get(turnId)
    if (!ctx) {
      log.warn('handlePermissionRequest: no context for turn', turnId)
      return
    }
    const request = claudePermissionToApprovalRequest(req.toolName, req.input)
    // 复合 requestId：`${turnId}:${bridgeRequestId}`——多 turn 并发隔离
    const requestId = `${turnId}:${req.requestId}`

    const promise = new Promise<ApprovalDecision['action']>((resolve) => {
      ctx.pendingApprovals.set(requestId, {
        resolve,
        bridgeRequestId: req.requestId,
        originalInput: req.input,
      })
    })

    // 推 approval_requested 事件到当前 turn 的队列（source='claude' 让 renderer 区分）
    ctx.queue.push({
      type: 'approval_requested',
      turnId,
      requestId,
      request,
      source: 'claude',
    })
    ctx.resolveWait?.()

    // 用户决策后写回 bridge → MCP server → claude
    void promise.then((action) => {
      const behavior: 'allow' | 'deny' = action === 'reject' ? 'deny' : 'allow'
      const message = action === 'reject' ? '用户拒绝' : undefined
      ctx.bridge.respond(req.requestId, behavior, req.input, message)
      ctx.pendingApprovals.delete(requestId)
    })
  }

  async interrupt(turnId: string): Promise<void> {
    const ctx = this.turnContexts.get(turnId)
    if (!ctx) {
      log.warn('interrupt: no context for turn', turnId)
      return
    }
    log.info('interrupting claude process, turn=', turnId)
    // 先 delete turnContexts，让 generator finally 块的 cleanupTurnContext 变 no-op（避免竞争）
    this.turnContexts.delete(turnId)
    try {
      ctx.proc.kill('SIGTERM')
    } catch (e) {
      log.warn('interrupt kill failed:', e)
    }
    // reject 所有 pendingApprovals（让 promise 完成，避免内存泄漏）
    for (const [, pending] of ctx.pendingApprovals) {
      pending.resolve('reject')
    }
    ctx.pendingApprovals.clear()
    // stop bridge + 删 mcp-config
    try {
      await ctx.bridge.stop()
    } catch (e) {
      log.warn('interrupt bridge stop failed:', e)
    }
    if (ctx.mcpConfigPath) {
      try {
        await unlink(ctx.mcpConfigPath)
      } catch {
        // 忽略
      }
    }
  }

  async respondApproval(decision: ApprovalDecision): Promise<void> {
    // requestId 是复合形式 `${turnId}:${bridgeRequestId}`——拆出 turnId 找 context
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
}
