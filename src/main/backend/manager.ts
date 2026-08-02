/**
 * BackendManager —— 单例，挂在 ctx 上。
 *
 * 职责：
 * - 持有所有 adapter 实例（按 BackendId）
 * - 路由当前后端到对应 adapter
 * - 把 turn 生命周期委托给 PerTurnCoordinator
 * - 把 adapter 的 TurnEvent 经 IPC 推送到 renderer
 * - 接收 renderer 的 interrupt / approval 调用，转给 adapter
 */
import { randomUUID } from 'node:crypto'

import { ctx } from '@main/context'
import { logger } from '@main/service/logger'
import type { SlashCommandInfo } from '@shared/backend/slash-commands'
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
  type TurnConfigUpdate,
  type WarmupBackendArgs,
} from '@shared/backend/types'
import type { BackendId } from '@shared/constants'
import type { TurnRunRecord } from '@shared/domain'
import type { CoordinatedStartTurnArgs } from '@shared/ipc/backend'
import type { AppSettings } from '@shared/settings-schema'

import { registerMainBackendPlugins } from './plugin-loader'
import {
  getBackendPlugins,
  type BackendPluginContext,
  type MainBackendPlugin,
} from './plugin-registry'
import { PerTurnCoordinator, type PerTurnCoordinatorOptions } from './turn/per-turn-coordinator'

const log = logger.domain('backend-manager')

export interface BackendManagerOptions {
  turnCoordinator?: PerTurnCoordinator
  turnCoordinatorOptions?: PerTurnCoordinatorOptions
}

export class BackendManager {
  private adapters = new Map<BackendId, AgentBackend>()
  private plugins = new Map<BackendId, MainBackendPlugin>()
  private currentBackendId: BackendId = 'codex'
  private readonly turnCoordinator: PerTurnCoordinator
  /**
   * claude 内部 sessionId（startSession 生成的占位 UUID）→ claude 真实 session_id 的映射。
   * 由 onRealSessionId 回调写入，refreshClaudeSessionTitle 用它把 args.sessionId
   * 翻译成真实 id 后再查 db（db 里的 backend_thread_id 已被 onRealSessionId 回写）。
   */
  private claudeSessionIdMap = new Map<string, string>()

  constructor(plugins?: MainBackendPlugin[], options: BackendManagerOptions = {}) {
    this.turnCoordinator =
      options.turnCoordinator ??
      new PerTurnCoordinator({
        ...options.turnCoordinatorOptions,
        onError: (error) => log.error('turn coordinator error:', error),
      })
    registerMainBackendPlugins()
    const context: BackendPluginContext = {
      onBackendThreadIdResolved: (backendId, internalId, realId) => {
        if (backendId === 'claude') this.claudeSessionIdMap.set(internalId, realId)
        if (internalId === realId) return
        try {
          ctx.db.updateSessionBackendThreadId(backendId, internalId, realId)
          log.info('persisted backend real session id', backendId, internalId, '→', realId)
        } catch (error) {
          log.warn('failed to persist backend real session id:', error)
        }
      },
    }
    for (const plugin of plugins ?? getBackendPlugins()) {
      const adapter = plugin.createAdapter(context)
      if (adapter.id !== plugin.manifest.id) {
        throw new Error(
          `backend plugin "${plugin.manifest.id}" created adapter with id "${adapter.id}"`,
        )
      }
      const undeclaredBlocks = adapter.capabilities.chat.blockTypes.filter(
        (type) => !plugin.manifest.blockTypes.includes(type),
      )
      if (undeclaredBlocks.length > 0) {
        throw new Error(
          `backend plugin "${plugin.manifest.id}" adapter emits undeclared blocks: ${undeclaredBlocks.join(', ')}`,
        )
      }
      this.plugins.set(plugin.manifest.id, plugin)
      this.adapters.set(plugin.manifest.id, adapter)
    }
    if (!this.adapters.has(this.currentBackendId)) {
      this.currentBackendId = this.adapters.keys().next().value ?? 'codex'
    }
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
    for (const [id, plugin] of this.plugins) {
      const adapter = this.adapters.get(id)
      if (adapter) plugin.applySettings?.(adapter, settings)
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

  /**
   * 重连指定后端：先结算它的活跃 turn，再 dispose（杀进程）+ 重新 initialize。
   *
   * 用于「后端进程已 spawn，但后续配置变化需要重新 spawn 才能生效」的场景——
   * 最典型的是 Protocol Bridge：codex 早于桥 spawn 时没拿到 `-c model_provider`
   * 参数，用户后来开启桥后必须重 spawn codex 才能让它指向本机桥。
   *
   * 顺序很重要：先 interruptBackend 清空活跃 turn（释放 lane，避免重连后的新 turn
   * 被死 entry 阻塞），再 dispose 杀进程，最后 initialize 用更新后的 extraArgs 重 spawn。
   * applySettings 必须在此调用之前执行过——它负责把新参数写进 adapter 字段。
   */
  async reconnectBackend(id: BackendId): Promise<void> {
    const adapter = this.adapters.get(id)
    if (!adapter) {
      log.warn('reconnectBackend: unknown backend', id)
      return
    }
    await this.turnCoordinator.interruptBackend(id)
    await adapter.dispose()
    await adapter.initialize()
    log.info('reconnected backend', id)
  }

  /** 列出所有后端的 status */
  async listStatuses(): Promise<BackendStatus[]> {
    return Promise.all(
      Array.from(this.adapters.keys()).map(async (id) => {
        const adapter = this.adapters.get(id)!
        const manifest = this.plugins.get(id)?.manifest
        const health = await adapter.healthCheck()
        return {
          id,
          ...(manifest
            ? { displayName: manifest.displayName, pluginVersion: manifest.version }
            : {}),
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
          chat: {
            subAgents: false,
            compact: false,
            planMode: false,
            webTools: false,
            blockTypes: ['text', 'reasoning', 'tool_call', 'context'],
          },
        },
      }
    }
    const health = await adapter.healthCheck()
    const manifest = this.plugins.get(id)?.manifest
    return {
      id,
      ...(manifest ? { displayName: manifest.displayName, pluginVersion: manifest.version } : {}),
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
   * 列出指定 backend 的模型（不切换当前 backend）。
   * 直接取 adapters 里的实例，不走 getCurrent()——用于设置页同时拉两个 backend 的模型列表。
   * 注意：codex 首次调用会触发 initialize（spawn app-server）。
   */
  async listModelsForBackend(id: BackendId): Promise<ModelOption[]> {
    const adapter = this.adapters.get(id)
    if (!adapter) {
      throw new BackendError('not-initialized', `unknown backend: ${id}`)
    }
    return adapter.listModels()
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

  /**
   * 强制刷新**指定** backend 的模型列表，不依赖当前 backend。
   * 设置页用：协议桥那一节要刷 codex 的列表，但当前 backend 可能是 claude。
   */
  async refreshModelsForBackend(id: BackendId): Promise<ModelOption[]> {
    const adapter = this.adapters.get(id)
    if (!adapter) {
      throw new BackendError('not-initialized', `unknown backend: ${id}`)
    }
    adapter.invalidateModelsCache?.()
    return adapter.listModels()
  }

  /** 预热指定 backend，不依赖可能已切换的 currentBackendId。 */
  async warmupBackend(id: BackendId, args: WarmupBackendArgs): Promise<void> {
    const adapter = this.adapters.get(id)
    if (!adapter?.warmup) {
      log.debug('warmup ignored: backend does not support it', id)
      return
    }
    log.info('warmup requested', id, {
      cwd: args.cwd,
      model: args.model ?? 'default',
      effort: args.effort ?? 'default',
    })
    await adapter.warmup(args)
  }

  /**
   * 列出某后端在该 cwd 下的斜杠命令。
   *
   * 后端没实现（codex）就返回空数组，而不是抛错——「这个后端没有斜杠命令」是一个
   * 正常状态，不是故障。拉取失败同样吞掉：输入框联想退回静态兜底表就行，
   * 不该让一次可选的补充查询把调用方带崩。
   */
  async listSlashCommands(id: BackendId, cwd: string): Promise<SlashCommandInfo[]> {
    const adapter = this.adapters.get(id)
    if (!adapter?.listSlashCommands) return []
    try {
      return await adapter.listSlashCommands(cwd)
    } catch (error) {
      log.debug('listSlashCommands failed', id, error)
      return []
    }
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
  async startTurn(args: CoordinatedStartTurnArgs): Promise<{ turnId: string }> {
    const { clientTurnId, ...backendArgs } = args
    const turnId = clientTurnId ?? randomUUID()
    const adapter = this.getCurrent()
    const backendId = this.currentBackendId
    // envelope 的 sessionId 用 clientSessionId（catmax session.id）——renderer 的
    // messageStore 按 clientSessionId 路由 events 到对应 session 状态。
    // clientSessionId 不传时 fallback 到 args.sessionId（向后兼容）。
    const routeSessionId = args.clientSessionId ?? args.sessionId

    this.turnCoordinator.enqueue({
      id: turnId,
      sessionId: routeSessionId,
      backend: backendId,
      // CodexAdapter 当前由一个 app-server 进程承载，内部只有一个活动事件 sink。
      // 不同 CatMax session 若并发启动会互相覆盖 sink，导致实时消息串流；
      // 共用 backend lane 串行执行，同时 envelope 仍按 routeSessionId 分发。
      ...(backendId === 'codex' ? { laneKey: 'backend:codex' } : {}),
      run: async (sink) => {
        for await (const event of adapter.startTurn(backendArgs)) {
          sink.publish(event)
        }
      },
      interrupt: async (backendTurnId) => {
        await adapter.interrupt(backendTurnId)
      },
      onEvent: (event) => {
        ctx.broadcast('backend:turnEvent', { turnId, sessionId: routeSessionId, event })
      },
      onSettled: (record) => {
        // 实际启动过的 turn 结束后回写会话配置到 db。
        // routeSessionId 是 catmax session.id（db PK），用它而非 args.sessionId
        // （claude 第一次 turn 时 args.sessionId 是占位 UUID）。
        // thinking 已合并进 effort（'none' 档），无需单独字段。
        // COALESCE 保证 undefined 不覆盖已有值（model/effort/permissionMode 都 optional）。
        if (record.startedAt !== null) {
          ctx.db.bumpSessionTurn(
            routeSessionId,
            record.completedAt ?? Date.now(),
            backendArgs.model,
            backendArgs.effort,
            backendArgs.permissionMode,
          )
        }
        // turn 正常结束后，触发 aiTitle 刷新（claude 在 jsonl 里写了 ai-title 行）
        // 失败不阻塞——title 刷新失败不影响主流程
        if (backendId === 'claude' && record.startedAt !== null) {
          void this.refreshClaudeSessionTitle(backendArgs.sessionId, backendArgs.cwd).catch((e) =>
            log.warn('refreshClaudeSessionTitle failed:', e),
          )
        }
      },
    })

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
    // Session Rename: 用户手动改过标题就不再刷新。db 层的 updateSessionTitle 也带了
    // 同样的守卫，但这里必须提前返回——否则 titleChanged 广播照发，renderer 会把
    // 侧边栏改回 AI 标题，跟 db 里的实际值不一致（刷新后又变回来，像是"改名没生效"）。
    if (session.titleCustom) return
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
    if (await this.turnCoordinator.interrupt(turnId)) return
    // 兼容协调器接入前启动、但尚未结束的 adapter turn。
    await this.getCurrent().interrupt(turnId)
  }

  /** 响应 approval */
  async respondApproval(decision: ApprovalDecision): Promise<void> {
    const backendId = this.turnCoordinator.findBackendByRequestId(decision.requestId)
    const adapter = backendId ? this.adapters.get(backendId) : this.getCurrent()
    if (!adapter) return
    await adapter.respondApproval(decision)
  }

  /** 响应 agent 的问题（ask_user 工具） */
  async respondQuestion(args: {
    turnId: string
    requestId: string
    answer: AgentAnswer
  }): Promise<void> {
    const backendId =
      this.turnCoordinator.findBackendByRequestId(args.requestId) ??
      this.turnCoordinator.findBackend(args.turnId)
    const adapter = backendId ? this.adapters.get(backendId) : this.getCurrent()
    if (!adapter?.respondQuestion) return
    await adapter.respondQuestion({
      ...args,
      turnId: this.turnCoordinator.getBackendTurnId(args.turnId) ?? args.turnId,
    })
  }

  /** 运行中热切换 turn 配置（model/effort/permissionMode） */
  async updateTurnConfig(turnId: string, config: TurnConfigUpdate): Promise<void> {
    const backendId = this.turnCoordinator.findBackend(turnId)
    if (backendId) {
      const adapter = this.adapters.get(backendId)
      if (!adapter?.updateTurnConfig) return
      this.turnCoordinator.dispatchWhenBound(turnId, (backendTurnId) =>
        adapter.updateTurnConfig!(backendTurnId, config),
      )
      return
    }

    const adapter = this.getCurrent()
    if (!adapter.updateTurnConfig) {
      // 当前 backend 不支持热切换，静默忽略（UI 侧应已根据 supportsHotSwap 判断）
      return
    }
    await adapter.updateTurnConfig(turnId, config)
  }

  /** 向运行中的 turn 追加用户指令；按协调器记录路由到启动它的 backend。 */
  async steerTurn(turnId: string, prompt: string): Promise<void> {
    const backendId = this.turnCoordinator.findBackend(turnId)
    if (backendId) {
      const adapter = this.adapters.get(backendId)
      if (!adapter?.steer) return
      this.turnCoordinator.dispatchWhenBound(turnId, (backendTurnId) =>
        adapter.steer!(backendTurnId, prompt),
      )
      return
    }

    const adapter = this.getCurrent()
    if (adapter.steer) await adapter.steer(turnId, prompt)
  }

  /**
   * 停止单个后台任务。
   *
   * taskId 不带 backend/turn 归属，而后台任务只有 claude 有，所以广播给所有
   * 实现了该方法的 adapter，由持有该任务的那个自行认领（其余是 no-op）。
   */
  async stopBackgroundTask(taskId: string): Promise<void> {
    await Promise.all(
      [...this.adapters.values()].map(async (adapter) => {
        if (!adapter.stopBackgroundTask) return
        try {
          await adapter.stopBackgroundTask(taskId)
        } catch (e) {
          log.warn('stopBackgroundTask failed on adapter', adapter.id, e)
        }
      }),
    )
  }

  listTurnRuns(sessionId?: string): TurnRunRecord[] {
    return this.turnCoordinator.list(sessionId)
  }

  /** App 启动、数据库 migrate 后调用。 */
  recoverInterruptedTurns(): TurnRunRecord[] {
    const recovered = this.turnCoordinator.recoverInterrupted()
    if (recovered.length > 0) {
      log.warn('recovered stale turn runs as interrupted:', recovered.length)
    }
    return recovered
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
   * Session Fork: 让后端把会话历史复制一份，返回新的 backendThreadId。
   *
   * 与 deleteSession 的容错策略相反——这里失败必须抛：fork 拿不到新 thread id
   * 就没有会话可登记，静默吞掉只会让用户点了"复制会话"却什么都没发生。
   */
  async forkSession(
    backendId: BackendId,
    backendThreadId: string,
    cwd?: string,
  ): Promise<{ backendThreadId: string }> {
    const adapter = this.adapters.get(backendId)
    if (!adapter) {
      throw new BackendError('not-initialized', `unknown backend: ${backendId}`)
    }
    if (!adapter.forkSession) {
      throw new BackendError('protocol', `后端 ${backendId} 不支持复制会话`)
    }
    return adapter.forkSession(backendThreadId, cwd)
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
    await this.turnCoordinator.dispose()
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.dispose()
      } catch (e) {
        log.error('dispose error:', e)
      }
    }
  }
}
