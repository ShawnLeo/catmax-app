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
import { type AssistantMessage, type ResultMessage } from '@shared/backend/claude-schema'
import {
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

import { assistantToEvents, resultToEvent, userToolResultToEvents } from './mapping'
import { encodeUserMessage, LineBuffer, parseClaudeLine } from './protocol'

const log = logger.domain('claude-adapter')

export interface ClaudeAdapterOptions {
  binaryPath?: string
  spawner?: ProcessSpawner
  cwd?: string
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

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.opts = opts
    this.spawner = opts.spawner ?? new RealProcessSpawner()
  }

  async initialize(): Promise<void> {
    // claude 不需要预初始化——每次 turn 启动新进程
    log.info('initialized (lazy, per-turn)')
  }

  async healthCheck(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const { execSync } = await import('node:child_process')
      const binary = this.opts.binaryPath ?? 'claude'
      const output = execSync(`${binary} --version`, { encoding: 'utf-8', timeout: 5000 })
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

  async *startTurn(args: StartTurnArgs): AsyncIterable<TurnEvent> {
    const internalTurnId = randomUUID()
    yield { type: 'turn_started', turnId: internalTurnId, sessionId: args.sessionId }

    // 找 claude session_id
    const claudeSessionId = this.sessionIdMap.get(args.sessionId) ?? args.sessionId

    // 启动 claude 进程
    const binary = this.opts.binaryPath ?? 'claude'
    const procArgs = [
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--resume',
      claudeSessionId,
    ]
    if (args.model) {
      procArgs.push('--model', args.model)
    }
    if (args.effort) {
      procArgs.push('--effort', args.effort)
    }
    if (args.permissionMode) {
      procArgs.push('--permission-mode', args.permissionMode)
    }

    this.currentProc = this.spawner.spawn({
      command: binary,
      args: procArgs,
      ...(this.opts.cwd !== undefined ? { cwd: this.opts.cwd } : {}),
    })

    // 写用户消息到 stdin 并 close（claude 一次只处理一条 user 消息）
    this.currentProc.write(encodeUserMessage(args.prompt) + '\n')
    this.currentProc.endInput()

    // 读 stdout 流，转 TurnEvent
    const queue: TurnEvent[] = []
    let resolveWait: (() => void) | null = null
    let done = false
    const lineBuffer = new LineBuffer()

    const onChunk = (chunk: Buffer): void => {
      const lines = lineBuffer.push(chunk)
      for (const line of lines) {
        const msg = parseClaudeLine(line)
        if (!msg) continue
        if (msg.type === 'system') {
          // 记下 claude 真实 session_id
          if (msg.session_id) {
            this.sessionIdMap.set(args.sessionId, msg.session_id)
          }
          continue
        }
        if (msg.type === 'assistant') {
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
          queue.push(resultToEvent(msg as ResultMessage, internalTurnId))
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
          if (event.type === 'turn_completed' || event.type === 'error') {
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
