import { ctx } from '@main/context'
import {
  cancelBackendInstall as cancelInstall,
  installBackend as runBackendInstall,
} from '@main/service/backend-installer'
import { logger } from '@main/service/logger'
import type { BackendInstallResult } from '@shared/backend/install'
import type {
  AgentAnswer,
  ApprovalDecision,
  TurnConfigUpdate,
  WarmupBackendArgs,
} from '@shared/backend/types'
import { PUSH, type BackendId } from '@shared/constants'
import type { CoordinatedStartTurnArgs } from '@shared/ipc/backend'

const log = logger.domain('backend-handler')

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

export const startTurn = async (args: CoordinatedStartTurnArgs) => {
  return ctx.backendManager.startTurn(args)
}

export const interruptTurn = async (args: { turnId: string }) => {
  await ctx.backendManager.interruptTurn(args.turnId)
}

export const steerTurn = async (args: { turnId: string; prompt: string }) => {
  await ctx.backendManager.steerTurn(args.turnId, args.prompt)
}

export const listTurnRuns = async (args?: { sessionId?: string }) => {
  return ctx.backendManager.listTurnRuns(args?.sessionId)
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

/**
 * Backend Install: 下载安装后端 CLI，成功后把路径写进 settings 并热应用。
 *
 * 写 settings 而不是让 installer 直接改 adapter——这样"用户手动指定的路径"和
 * "一键装出来的路径"是同一条链路（settings.backendPaths → applySettings），
 * 卸载/换路径的行为完全一致，也能在重启后保持。
 */
export const installBackend = async (args: { id: BackendId }): Promise<BackendInstallResult> => {
  const settings = ctx.settingsStore.load()
  const proxyUrl = settings.httpProxy.enabled ? settings.httpProxy.url : null

  const result = await runBackendInstall({
    id: args.id,
    proxyUrl,
    onProgress: (progress) => ctx.broadcast(PUSH.BACKEND_INSTALL_PROGRESS, progress),
  })

  if (result.ok && result.binaryPath) {
    const current = ctx.settingsStore.load()
    const updated = ctx.settingsStore.update({
      backendPaths: { ...current.backendPaths, [args.id]: result.binaryPath },
    })
    try {
      ctx.backendManager.applySettings(updated)
    } catch (e) {
      log.warn('applySettings after install failed:', e)
    }
    // 让设置页立刻看到"已可用"，不用等下一次 refresh
    const status = await ctx.backendManager.getStatus(args.id)
    ctx.broadcast(PUSH.BACKEND_STATUS_CHANGED, { status })
  }

  return result
}

export const cancelBackendInstall = async (args: { id: BackendId }) => {
  cancelInstall(args.id)
}
