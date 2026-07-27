import { ctx } from '@main/context'
import type {
  AgentAnswer,
  ApprovalDecision,
  StartTurnArgs,
  TurnConfigUpdate,
  WarmupBackendArgs,
} from '@shared/backend/types'
import type { BackendId } from '@shared/constants'

export const listBackends = async () => {
  return ctx.backendManager.listStatuses()
}

export const getCurrentBackend = async () => {
  return { id: ctx.backendManager.getCurrentId() }
}

export const switchBackend = async (args: { id: BackendId }) => {
  await ctx.backendManager.switchBackend(args.id)
}

export const listModels = async () => {
  return ctx.backendManager.listModels()
}

export const listModelsFor = async (args: { id: BackendId }) => {
  return ctx.backendManager.listModelsForBackend(args.id)
}

export const refreshModels = async () => {
  return ctx.backendManager.refreshModels()
}

export const warmupBackend = async (args: { id: BackendId; config: WarmupBackendArgs }) => {
  await ctx.backendManager.warmupBackend(args.id, args.config)
}

export const startTurn = async (args: StartTurnArgs) => {
  return ctx.backendManager.startTurn(args)
}

export const interruptTurn = async (args: { turnId: string }) => {
  await ctx.backendManager.interruptTurn(args.turnId)
}

export const respondApproval = async (args: ApprovalDecision) => {
  await ctx.backendManager.respondApproval(args)
}

export const respondQuestion = async (args: {
  turnId: string
  requestId: string
  answer: AgentAnswer
}) => {
  await ctx.backendManager.respondQuestion(args)
}

export const updateTurnConfig = async (args: { turnId: string; config: TurnConfigUpdate }) => {
  await ctx.backendManager.updateTurnConfig(args.turnId, args.config)
}
