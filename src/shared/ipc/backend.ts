/**
 * backend domain IPC 契约。
 * 函数签名即契约——main 实现，renderer 通过 window.api 调用。
 */
import type {
  ApprovalDecision,
  BackendStatus,
  ModelOption,
  StartTurnArgs,
  TurnEvent,
} from '../backend/types'
import type { BackendId } from '../constants'

export type BackendHandlers = {
  'backend.list': () => Promise<BackendStatus[]>
  'backend.current': () => Promise<{ id: BackendId }>
  'backend.switch': (args: { id: BackendId }) => Promise<void>
  'backend.listModels': () => Promise<ModelOption[]>
  'backend.startTurn': (args: StartTurnArgs) => Promise<{ turnId: string }>
  'backend.interruptTurn': (args: { turnId: string }) => Promise<void>
  'backend.respondApproval': (args: ApprovalDecision) => Promise<void>
}

/** 主→渲染推送事件类型 */
export type BackendPushEvents = {
  'backend:turnEvent': { turnId: string; event: TurnEvent }
  'backend:switched': { id: BackendId }
  'backend:statusChanged': { status: BackendStatus }
}
