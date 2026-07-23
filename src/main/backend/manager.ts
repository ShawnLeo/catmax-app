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
  type AgentAnswer,
  type AgentBackend,
  type ApprovalDecision,
  type BackendStatus,
  type ModelOption,
  type NormalizedMessage,
  type SessionSummary,
  type StartSessionArgs,
  type StartTurnArgs,
  type TurnConfigUpdate,
  type TurnEvent,
} from '@shared/backend/types'
import type { BackendId } from '@shared/constants'
import type { AppSettings } from '@shared/settings-schema'

import { ClaudeAdapter } from './claude/adapter'
import { CodexAdapter } from './codex/adapter'
import { proxySettingsToEnv } from './proxy-env'

const log = logger.domain('backend-manager')

export class BackendManager {
  private adapters = new Map<BackendId, AgentBackend>()
  private currentBackendId: BackendId = 'codex'
  /**
   * claude 内部 sessionId（startSession 生成的占位 UUID）→ claude 真实 session_id 的映射。
   * 由 onRealSessionId 回调写入，refreshClaudeSessionTitle 用它把 args.sessionId
   * 翻译成真实 id 后再查 db（db 里的 backend_thread_id 已被 onRealSessionId 回写）。
   */
  private claudeSessionIdMap = new Map<string, string>()

  constructor() {
    this.adapters.set('codex', new CodexAdapter())
    this.adapters.set(
      'claude',
      new ClaudeAdapter({
        // 拿到 claude 真实 session_id 时把 db 里 session.backend_thread_id 从占位 UUID
        // 更新成真实 id。这样重启应用后用户点历史会话时，getHistory 调 claude --resume
        // 才能真的找到会话。
        onRealSessionId: (internalId, realSessionId) => {
          // 记映射——refreshClaudeSessionTitle 用得到
          this.claudeSessionIdMap.set(internalId, realSessionId)
          if (internalId === realSessionId) return // 没变化（续接已有会话时）
          try {
            ctx.db.updateSessionBackendThreadId('claude', internalId, realSessionId)
            log.info('persisted claude real session_id', internalId, '→', realSessionId)
          } catch (e) {
            log.warn('failed to persist claude real session_id:', e)
          }
        },
      }),
    )
  }

  /**
   * 应用 settings.json 中的后端相关配置。
   * 必须在 settingsStore.load() 之后调用：
   * - 把 backendPaths.{codex,claude} 注入到对应 adapter（用作 binaryPath）
   * - 把 defaultBackend 设为当前后端（不调 initialize——lazy 等真正用时再握手，
   *   避免启动时强制拉起一个用户没在用的后端进程）
   *
   * 注意：只在当前后端与 settings 不一致时切换——用户在本次会话里手动切过的话，
   * 这里不应该覆盖（但 settings 是启动时加载的，所以正常顺序下不会有冲突）。
   */
  applySettings(settings: AppSettings): void {
    // 注入 binaryPath —— 路径变了的话同时清模型缓存，因为新 binary 可能是不同版本，
    // 支持的模型列表可能不一样（比如 codex 升级后多了 gpt-5.3-codex）。
    const codexAdapter = this.adapters.get('codex')
    if (codexAdapter instanceof CodexAdapter && settings.backendPaths.codex) {
      const pathChanged = codexAdapter.getBinaryPath() !== settings.backendPaths.codex
      codexAdapter.setBinaryPath(settings.backendPaths.codex)
      if (pathChanged) codexAdapter.invalidateModelsCache()
    }
    const claudeAdapter = this.adapters.get('claude')
    if (claudeAdapter instanceof ClaudeAdapter && settings.backendPaths.claude) {
      claudeAdapter.setBinaryPath(settings.backendPaths.claude)
    }

    // 把代理设置转成 env 注入到所有 adapter —— codex/claude CLI 调 LLM API 时
    // 都靠 HTTPS_PROXY 环境变量走代理（macOS 系统代理不会自动传给子进程）。
    const proxyEnv = proxySettingsToEnv(settings.httpProxy)
    if (Object.keys(proxyEnv).length > 0) {
      for (const adapter of this.adapters.values()) {
        if (adapter instanceof CodexAdapter || adapter instanceof ClaudeAdapter) {
          adapter.setExtraEnv(proxyEnv)
        }
      }
      log.info('applied proxy env to adapters:', Object.keys(proxyEnv))
    } else {
      // 用户关了代理——清掉之前注入的 env
      for (const adapter of this.adapters.values()) {
        if (adapter instanceof CodexAdapter || adapter instanceof ClaudeAdapter) {
          adapter.setExtraEnv({})
        }
      }
    }

    // 应用 defaultBackend（仅当当前还是初始默认值时——避免覆盖运行时的 switchBackend）
    if (settings.defaultBackend !== this.currentBackendId) {
      const adapter = this.adapters.get(settings.defaultBackend)
      if (adapter) {
        this.currentBackendId = settings.defaultBackend
        log.info('applied defaultBackend from settings:', settings.defaultBackend)
      } else {
        log.warn('defaultBackend in settings is unknown:', settings.defaultBackend)
      }
    }
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
    // 切走当前后端时清掉它的模型缓存——下次切回来会重新发 model/list。
    // 场景：用户在外部 codex login 换了账户，切回时希望看到新账户的模型列表，
    // 而不是上次缓存的。无缓存的 adapter（claude）invalidateModelsCache 是 undefined，跳过。
    const oldAdapter = this.adapters.get(this.currentBackendId)
    oldAdapter?.invalidateModelsCache?.()
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
          supportsHotSwap: false,
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

  /**
   * 强制刷新当前后端的模型列表——先清缓存再重新拉。
   * UI 上的"刷新模型"按钮调它。场景：用户在外面 codex login 换了账户，
   * 想立即看到新账户能用的模型，不想等下次切 backend。
   */
  async refreshModels(): Promise<ModelOption[]> {
    const adapter = this.getCurrent()
    adapter.invalidateModelsCache?.()
    return adapter.listModels()
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
   *
   * envelope 带 sessionId——多 turn 并发时 renderer 用它把事件路由到对应 session 状态。
   */
  async startTurn(args: StartTurnArgs): Promise<{ turnId: string }> {
    const turnId = randomUUID()
    const adapter = this.getCurrent()
    const backendId = this.currentBackendId
    // envelope 的 sessionId 用 clientSessionId（catmax session.id）——renderer 的
    // messageStore 按 clientSessionId 路由 events 到对应 session 状态。
    // clientSessionId 不传时 fallback 到 args.sessionId（向后兼容）。
    const routeSessionId = args.clientSessionId ?? args.sessionId

    // 后台驱动事件流
    void (async () => {
      try {
        for await (const event of adapter.startTurn(args)) {
          ctx.broadcast('backend:turnEvent', { turnId, sessionId: routeSessionId, event })
        }
        // turn 成功完成——回写会话配置到 db。
        // routeSessionId 是 catmax session.id（db PK），用它而非 args.sessionId
        // （claude 第一次 turn 时 args.sessionId 是占位 UUID）。
        // thinking 已合并进 effort（'none' 档），无需单独字段。
        // COALESCE 保证 undefined 不覆盖已有值（model/effort/permissionMode 都 optional）。
        ctx.db.bumpSessionTurn(
          routeSessionId,
          Date.now(),
          args.model,
          args.effort,
          args.permissionMode,
        )
        // turn 正常结束后，触发 aiTitle 刷新（claude 在 jsonl 里写了 ai-title 行）
        // 失败不阻塞——title 刷新失败不影响主流程
        if (backendId === 'claude') {
          void this.refreshClaudeSessionTitle(args.sessionId, args.cwd).catch((e) =>
            log.warn('refreshClaudeSessionTitle failed:', e),
          )
        }
      } catch (e) {
        const errorEvent: TurnEvent = {
          type: 'error',
          turnId,
          message: e instanceof Error ? e.message : String(e),
          recoverable: false,
        }
        ctx.broadcast('backend:turnEvent', { turnId, sessionId: routeSessionId, event: errorEvent })
      }
    })()

    return { turnId }
  }

  /**
   * turn 完成后从 jsonl 读 aiTitle，回写 db 并广播 sessionTitleChanged 事件
   * 让 renderer 刷新侧边栏。
   *
   * args.sessionId 在 claude 场景下是 startSession 时的占位 UUID。adapter 内部
   * sessionIdMap 把它映射到了真实 session_id；onRealSessionId 回调时 db 的
   * backend_thread_id 已经被回写成真实 id。所以查 db 时要用真实 id。
   */
  private async refreshClaudeSessionTitle(backendThreadId: string, cwd?: string): Promise<void> {
    // 翻译占位 id → 真实 id（onRealSessionId 回调时记下来的）
    const realThreadId = this.claudeSessionIdMap.get(backendThreadId) ?? backendThreadId
    const session = ctx.db.findSessionByBackendThreadId('claude', realThreadId)
    if (!session) {
      log.warn('refreshClaudeSessionTitle: session not found for', realThreadId)
      return
    }
    // 用 workspace.path 作为 cwd（claude jsonl 按 cwd 分目录存）
    const workspace = ctx.db.findWorkspaceById(session.workspaceId)
    const realCwd = cwd ?? workspace?.path
    const claudeAdapter = this.adapters.get('claude') as AgentBackend | undefined
    if (!claudeAdapter) return

    try {
      const { aiTitle } = await claudeAdapter.getHistory(realThreadId, realCwd)
      if (aiTitle && aiTitle !== session.title) {
        ctx.db.updateSessionTitle(session.id, aiTitle)
        log.info('title refreshed after turn', session.id, aiTitle)
        // 广播给 renderer——sessionStore 监听后更新本地 sessions 数组
        ctx.broadcast('session:titleChanged', { sessionId: session.id, title: aiTitle })
      }
    } catch (e) {
      // getHistory 可能失败（jsonl 还没刷盘 / 找不到文件等），不报错
      log.warn('refreshClaudeSessionTitle: getHistory failed:', e)
    }
  }

  /** 中断 turn */
  async interruptTurn(turnId: string): Promise<void> {
    return this.getCurrent().interrupt(turnId)
  }

  /** 响应 approval */
  async respondApproval(decision: ApprovalDecision): Promise<void> {
    return this.getCurrent().respondApproval(decision)
  }

  /** 响应 agent 的问题（ask_user 工具） */
  async respondQuestion(args: {
    turnId: string
    requestId: string
    answer: AgentAnswer
  }): Promise<void> {
    const adapter = this.getCurrent()
    if (!adapter.respondQuestion) return
    return adapter.respondQuestion(args)
  }

  /** 运行中热切换 turn 配置（model/effort/permissionMode） */
  async updateTurnConfig(turnId: string, config: TurnConfigUpdate): Promise<void> {
    const adapter = this.getCurrent()
    if (!adapter.updateTurnConfig) {
      // 当前 backend 不支持热切换，静默忽略（UI 侧应已根据 supportsHotSwap 判断）
      return
    }
    return adapter.updateTurnConfig(turnId, config)
  }

  /**
   * 读会话历史（按 session.backend 选 adapter，不是当前 backend）。
   * 用于 UI 点击侧边栏会话时显示完整历史，只读、不影响后端状态。
   *
   * cwd 必须传——claude adapter 用它作 spawn cwd（历史文件按 cwd 分目录存）。
   * 返回值里的 aiTitle 是后端给的会话标题（claude jsonl 里的 aiTitle 字段）。
   */
  async getHistory(
    backend: BackendId,
    backendThreadId: string,
    cwd?: string,
  ): Promise<{ messages: NormalizedMessage[]; aiTitle?: string | null }> {
    const adapter = this.adapters.get(backend)
    if (!adapter) {
      throw new BackendError('not-initialized', `unknown backend: ${backend}`)
    }
    return adapter.getHistory(backendThreadId, cwd)
  }

  /** 列出后端会话（透传给 adapter） */
  async listSessions(cwd?: string) {
    return this.getCurrent().listSessions(cwd)
  }

  /**
   * 物理删除后端侧会话数据（claude jsonl / codex rollout 文件）。
   *
   * 按 backendId 路由到对应 adapter 的 deleteSession。
   * adapter 没实现 / 报错都不抛——上层 removeSession 会同时写 DB tombstone 兜底，
   * 即便这里删不掉文件，reconcile/扫描导入也不会让会话复活。
   */
  async deleteSession(backendId: BackendId, backendThreadId: string, cwd?: string): Promise<void> {
    const adapter = this.adapters.get(backendId)
    if (!adapter?.deleteSession) return // backend 没实现就不删
    try {
      await adapter.deleteSession(backendThreadId, cwd)
    } catch (e) {
      log.warn('backend.deleteSession failed', backendId, backendThreadId, e)
    }
  }

  /**
   * 全盘扫描所有 backend 的会话（用于「扫描导入」功能）。
   *
   * 与 `listSessions` 的差异：
   * - 不只查当前 backend，遍历所有 adapter（codex + claude）
   * - 不传 cwd——codex thread/list 返回全部；claude 扫所有 ~/.claude/projects/*
   * - 单 backend 失败容错——记到 errors 数组，不影响其他 backend 的结果
   *
   * 注意 codex 调 listSessions 会触发 ensureInitialized——如果 codex 进程没在线
   * 会卡 30s 超时，所以这里用 Promise.allSettled 不阻塞其他 backend。
   */
  async listAllSessionsAcrossBackends(): Promise<{
    byBackend: Record<BackendId, SessionSummary[]>
    errors: Array<{ backend: BackendId; error: string }>
  }> {
    const backendIds = Array.from(this.adapters.keys())
    const settled = await Promise.allSettled(
      backendIds.map(async (id) => ({
        backend: id,
        sessions: await this.adapters.get(id)!.listSessions(),
      })),
    )

    const byBackend = {} as Record<BackendId, SessionSummary[]>
    const errors: Array<{ backend: BackendId; error: string }> = []
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        byBackend[result.value.backend] = result.value.sessions
      } else {
        // 失败的 backend——在 byBackend 里给个空数组，UI 能正常 iterate
        // 但要从未 fulfilled 列表里反推 backend id（allSettled 保留顺序，对照 backendIds）
        const failedIdx = settled.indexOf(result)
        const backend = backendIds[failedIdx] ?? 'codex'
        byBackend[backend] = []
        const message =
          result.reason instanceof Error ? result.reason.message : String(result.reason)
        errors.push({ backend, error: message })
        log.warn(`listSessions failed for ${backend}:`, message)
      }
    }
    return { byBackend, errors }
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
