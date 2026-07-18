/**
 * BackendManager —— 单例，挂在 ctx 上。
 *
 * 职责：
 * - 持有所有 adapter 实例（按 BackendId）
 * - 路由当前后端到对应 adapter
 * - 维护 activeTurns（turnId → sessionId 映射）
 * - 把 adapter 的 TurnEvent 经 IPC 推送到 renderer
 * - 接收 renderer 的 interrupt / approval 调用，转给 adapter
 */
import { randomUUID } from 'node:crypto'

import { ctx } from '@main/context'
import { logger } from '@main/service/logger'
import {
  BackendError,
  type AgentBackend,
  type ApprovalDecision,
  type BackendStatus,
  type ModelOption,
  type StartSessionArgs,
  type StartTurnArgs,
  type TurnEvent,
} from '@shared/backend/types'
import type { BackendId } from '@shared/constants'

import { ClaudeAdapter } from './claude/adapter'
import { CodexAdapter } from './codex/adapter'

const log = logger.domain('backend-manager')

export class BackendManager {
  private adapters = new Map<BackendId, AgentBackend>()
  private currentBackendId: BackendId = 'codex'

  constructor() {
    this.adapters.set('codex', new CodexAdapter())
    this.adapters.set('claude', new ClaudeAdapter())
  }

  /** 当前后端 */
  getCurrent(): AgentBackend {
    const adapter = this.adapters.get(this.currentBackendId)
    if (!adapter) {
      throw new BackendError('not-initialized', `no adapter for ${this.currentBackendId}`)
    }
    return adapter
  }

  getCurrentId(): BackendId {
    return this.currentBackendId
  }

  /** 切换当前后端 */
  async switchBackend(id: BackendId): Promise<void> {
    if (id === this.currentBackendId) return
    const adapter = this.adapters.get(id)
    if (!adapter) {
      throw new BackendError('not-initialized', `unknown backend: ${id}`)
    }
    await adapter.initialize()
    this.currentBackendId = id
    log.info('switched backend to', id)

    // 推送给所有窗口
    ctx.broadcast('backend:switched', { id })

    // 也广播新的状态
    const status = await this.getStatus(id)
    ctx.broadcast('backend:statusChanged', { status })
  }

  /** 列出所有后端的 status */
  async listStatuses(): Promise<BackendStatus[]> {
    return Promise.all(
      Array.from(this.adapters.keys()).map(async (id) => {
        const adapter = this.adapters.get(id)!
        const health = await adapter.healthCheck()
        return {
          id,
          available: health.ok,
          version: health.version ?? null,
          error: health.error ?? null,
          capabilities: adapter.getCapabilities(),
        }
      }),
    )
  }

  /** 单个后端的 status */
  async getStatus(id: BackendId): Promise<BackendStatus> {
    const adapter = this.adapters.get(id)
    if (!adapter) {
      return {
        id,
        available: false,
        version: null,
        error: 'not-initialized',
        capabilities: {
          supportsInterrupt: false,
          supportsApproval: false,
          supportsSteer: false,
          supportsThreadFork: false,
          supportsModelSelection: false,
          supportsEffort: false,
          supportsPermissionMode: false,
          supportedPermissionModes: [],
          supportedEfforts: [],
        },
      }
    }
    const health = await adapter.healthCheck()
    return {
      id,
      available: health.ok,
      version: health.version ?? null,
      error: health.error ?? null,
      capabilities: adapter.getCapabilities(),
    }
  }

  /** 列出当前后端的模型 */
  async listModels(): Promise<ModelOption[]> {
    return this.getCurrent().listModels()
  }

  /** 启动会话 */
  async startSession(
    args: StartSessionArgs,
  ): Promise<{ sessionId: string; backendThreadId: string }> {
    return this.getCurrent().startSession(args)
  }

  /**
   * 启动 turn —— 异步驱动 AsyncIterable，把事件经 IPC 推送。
   * 立即返回 turnId（App 内部生成），不等 turn 完成。
   */
  async startTurn(args: StartTurnArgs): Promise<{ turnId: string }> {
    const turnId = randomUUID()
    const adapter = this.getCurrent()

    // 后台驱动事件流
    void (async () => {
      try {
        for await (const event of adapter.startTurn(args)) {
          ctx.broadcast('backend:turnEvent', { turnId, event })
        }
      } catch (e) {
        const errorEvent: TurnEvent = {
          type: 'error',
          turnId,
          message: e instanceof Error ? e.message : String(e),
          recoverable: false,
        }
        ctx.broadcast('backend:turnEvent', { turnId, event: errorEvent })
      }
    })()

    return { turnId }
  }

  /** 中断 turn */
  async interruptTurn(turnId: string): Promise<void> {
    return this.getCurrent().interrupt(turnId)
  }

  /** 响应 approval */
  async respondApproval(decision: ApprovalDecision): Promise<void> {
    return this.getCurrent().respondApproval(decision)
  }

  /** 列出后端会话（透传给 adapter） */
  async listSessions(cwd?: string) {
    return this.getCurrent().listSessions(cwd)
  }

  /** resume session（透传） */
  async resumeSession(backendThreadId: string) {
    return this.getCurrent().resumeSession(backendThreadId)
  }

  /** dispose 所有 adapter（app 退出时调） */
  async dispose(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.dispose()
      } catch (e) {
        log.error('dispose error:', e)
      }
    }
  }
}
