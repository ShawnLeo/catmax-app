import { ctx } from '@main/context'
import type { ApprovalDecision, StartTurnArgs } from '@shared/backend/types'
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

export const startTurn = async (args: StartTurnArgs) => {
  return ctx.backendManager.startTurn(args)
}

export const interruptTurn = async (args: { turnId: string }) => {
  await ctx.backendManager.interruptTurn(args.turnId)
}

export const respondApproval = async (args: ApprovalDecision) => {
  await ctx.backendManager.respondApproval(args)
}
