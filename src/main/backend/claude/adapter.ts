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

import { type ProcessSpawner, RealProcessSpawner } from '../process-spawner'

import { checkCliHealth } from '../health-check'

import { readHistoryFromJsonl } from './jsonl-reader'
import {
  StreamEventAggregator,
  assistantToEvents,
  resultToEvent,
  userToolResultToEvents,
} from './mapping'
import { encodeUserMessage, LineBuffer, parseClaudeLine } from './protocol'

const log = logger.domain('claude-adapter')

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
    supportsApproval: false, // claude MVP 不支持 approval UI
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

  /** 当前 turn 的子进程（用于 interrupt） */
  private currentProc: ReturnType<ProcessSpawner['spawn']> | null = null
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
    if (this.currentProc) {
      this.currentProc.kill('SIGTERM')
      this.currentProc = null
    }
    log.info('disposed')
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
    // MVP：claude 不维护可枚举的 session 列表（要 `claude --resume` 才能看到，且不友好）
    // 返回空——App db 里有索引即可
    void cwd
    return []
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
    log.info('history loaded from jsonl', backendThreadId, result.messages.length, 'messages, title=', result.aiTitle)
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
    const canResume = this.resumableSessions.has(args.sessionId)

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
    if (args.effort) {
      procArgs.push('--effort', args.effort)
    }
    if (args.permissionMode) {
      procArgs.push('--permission-mode', args.permissionMode)
    }

    // spawn cwd 优先级：调用方传入（args.cwd）> adapter opts > undefined（继承 main 进程 cwd）
    // Bug E-1：claude 是 per-turn process 模型，每次 turn 都要 spawn 新进程——
    // cwd 必须正确，否则文件工具和历史文件都会落到错误目录。
    const spawnCwd = args.cwd ?? this.opts.cwd
    this.currentProc = this.spawner.spawn({
      command: binary,
      args: procArgs,
      // 注入代理 env（claude 调 Anthropic API 时用得到）
      env: { ...this.extraEnv },
      ...(spawnCwd !== undefined ? { cwd: spawnCwd } : {}),
    })

    // 写用户消息到 stdin 并 close（claude 一次只处理一条 user 消息）
    this.currentProc.write(encodeUserMessage(args.prompt) + '\n')
    this.currentProc.endInput()

    // 读 stdout 流，转 TurnEvent
    const queue: TurnEvent[] = []
    let resolveWait: (() => void) | null = null
    let done = false
    const lineBuffer = new LineBuffer()
    // 流式事件聚合器：处理 --include-partial-messages 模式下的 stream_event
    const aggregator = new StreamEventAggregator(internalTurnId)
    // 跟踪是否见过 stream_event —— 如果见过，最终的完整 assistant 消息就忽略
    // （因为 aggregator 已经把每个 token 推给 UI 了，再处理完整块会重复显示）
    let sawStreamEvents = false

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
            queue.push(event)
            resolveWait?.()
          }
          continue
        }
        if (msg.type === 'assistant') {
          // 如果已经流式推送过（sawStreamEvents=true），最终的完整 assistant 消息忽略，
          // 避免重复。否则（没开 --include-partial-messages 时）才用完整块。
          if (sawStreamEvents) continue
          for (const event of assistantToEvents(msg as AssistantMessage, internalTurnId)) {
            queue.push(event)
            resolveWait?.()
          }
          continue
        }
        if (msg.type === 'user') {
          for (const event of userToolResultToEvents(msg, internalTurnId)) {
            queue.push(event)
            resolveWait?.()
          }
          continue
        }
        if (msg.type === 'result') {
          const resultMsg = msg as ResultMessage
          // 收尾：把还没收到 content_block_stop 的 tool_use 兜底发出
          if (sawStreamEvents) {
            for (const event of aggregator.flushPendingToolUse()) {
              queue.push(event)
              resolveWait?.()
            }
          }
          // Bug D-2：is_error 的 result 必须先推 error event，把 claude 报的错暴露给 UI。
          // 否则用户只看到「消息发出但没响应」——turn_completed('error') 不会带可读消息。
          if (resultMsg.is_error) {
            const errText =
              (Array.isArray(resultMsg.errors) && resultMsg.errors.length > 0
                ? resultMsg.errors.join('; ')
                : undefined) ?? 'claude turn ended with error (no detail)'
            queue.push({
              type: 'error',
              turnId: internalTurnId,
              message: errText,
              recoverable: false,
            })
          }
          queue.push(resultToEvent(resultMsg, internalTurnId))
          resolveWait?.()
          done = true
        }
      }
    }

    this.currentProc.child.stdout?.on('data', onChunk)
    this.currentProc.child.on('exit', () => {
      done = true
      resolveWait?.()
    })

    try {
      while (!done || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resolveWait = resolve
          })
          resolveWait = null
        }
        while (queue.length > 0) {
          const event = queue.shift()!
          yield event
          // 只有 turn_completed 终结 generator——error 事件后我们仍想 yield 跟在
          // 后面的 turn_completed（Bug D-2：error event 先 yield，紧接 turn_completed）。
          if (event.type === 'turn_completed') {
            this.currentProc = null
            return
          }
        }
      }
    } finally {
      this.currentProc = null
    }
  }

  async interrupt(turnId: string): Promise<void> {
    void turnId
    if (this.currentProc) {
      log.info('interrupting claude process')
      this.currentProc.kill('SIGTERM')
      this.currentProc = null
    }
  }

  async respondApproval(decision: ApprovalDecision): Promise<void> {
    // claude MVP 不支持 approval
    void decision
    log.warn('respondApproval called but claude does not support approval')
  }
}
