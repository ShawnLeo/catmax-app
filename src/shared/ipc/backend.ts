/**
 * backend domain IPC 契约。
 * 函数签名即契约——main 实现，renderer 通过 window.api 调用。
 */
import type { BackendInstallProgress, BackendInstallResult } from '../backend/install'
import type {
  AgentAnswer,
  ApprovalDecision,
  BackendStatus,
  ModelOption,
  StartTurnArgs,
  TurnConfigUpdate,
  TurnEvent,
  WarmupBackendArgs,
} from '../backend/types'
import type { BackendId } from '../constants'
import type { TurnRunRecord } from '../domain'

/**
 * renderer → BackendManager 的 turn 启动参数。
 *
 * clientTurnId 是 UI 乐观进入 running 状态时生成的稳定 ID，仅由 per-turn 协调器消费；
 * BackendManager 会在调用 adapter 前移除它，避免协调层元数据渗入 backend 协议。
 */
export type CoordinatedStartTurnArgs = StartTurnArgs & {
  clientTurnId?: string
}

export type BackendHandlers = {
  'backend.list': () => Promise<BackendStatus[]>
  'backend.current': () => Promise<{ id: BackendId }>
  'backend.switch': (args: { id: BackendId }) => Promise<void>
  'backend.listModels': () => Promise<ModelOption[]>
  /**
   * 列出指定 backend 的模型（不切换当前 backend）。
   * 用于设置页同时展示 codex / claude 两个 backend 的可选模型。
   * 注意：codex 首次调用会 spawn app-server 子进程。
   */
  'backend.listModelsFor': (args: { id: BackendId }) => Promise<ModelOption[]>
  'backend.refreshModels': () => Promise<ModelOption[]>
  'backend.warmup': (args: { id: BackendId; config: WarmupBackendArgs }) => Promise<void>
  'backend.startTurn': (args: CoordinatedStartTurnArgs) => Promise<{ turnId: string }>
  'backend.interruptTurn': (args: { turnId: string }) => Promise<void>
  'backend.steerTurn': (args: { turnId: string; prompt: string }) => Promise<void>
  'backend.listTurnRuns': (args?: { sessionId?: string }) => Promise<TurnRunRecord[]>
  'backend.respondApproval': (args: ApprovalDecision) => Promise<void>
  /** 响应 agent 的问题（ask_user 工具）：把用户答案回流给阻塞中的 handler */
  'backend.respondQuestion': (args: {
    turnId: string
    requestId: string
    answer: AgentAnswer
  }) => Promise<void>
  /** 运行中热切换 model/effort/permissionMode（仅 supportsHotSwap 的 backend） */
  'backend.updateTurnConfig': (args: { turnId: string; config: TurnConfigUpdate }) => Promise<void>
  /**
   * Backend Install: 下载并安装后端 CLI（目前只有 codex）。
   * 整个过程可能几分钟（tarball ~100MB），进度走 `backend:installProgress` 推送。
   * 成功时会把二进制路径写进 settings.backendPaths 并热应用到 adapter。
   */
  'backend.install': (args: { id: BackendId }) => Promise<BackendInstallResult>
  /** 取消进行中的安装；没有进行中的安装时是 no-op */
  'backend.cancelInstall': (args: { id: BackendId }) => Promise<void>
}

/** 主→渲染推送事件类型 */
export type BackendPushEvents = {
  /**
   * turn 事件——envelope 带 sessionId 让 renderer 把事件路由到对应 session 状态
   * （多 turn 并发时各个 session 的事件互不串台）。
   */
  'backend:turnEvent': { turnId: string; sessionId: string; event: TurnEvent }
  'backend:switched': { id: BackendId }
  'backend:statusChanged': { status: BackendStatus }
  /** Backend Install: 安装进度（含终态 done/error/cancelled） */
  'backend:installProgress': BackendInstallProgress
}
