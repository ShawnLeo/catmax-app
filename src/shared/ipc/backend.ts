/**
 * backend domain IPC 契约。
 * 函数签名即契约——main 实现，renderer 通过 window.api 调用。
 */
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
  'backend.startTurn': (args: StartTurnArgs) => Promise<{ turnId: string }>
  'backend.interruptTurn': (args: { turnId: string }) => Promise<void>
  'backend.respondApproval': (args: ApprovalDecision) => Promise<void>
  /** 响应 agent 的问题（ask_user 工具）：把用户答案回流给阻塞中的 handler */
  'backend.respondQuestion': (args: {
    turnId: string
    requestId: string
    answer: AgentAnswer
  }) => Promise<void>
  /** 运行中热切换 model/effort/permissionMode（仅 supportsHotSwap 的 backend） */
  'backend.updateTurnConfig': (args: { turnId: string; config: TurnConfigUpdate }) => Promise<void>
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
}
