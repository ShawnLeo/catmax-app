import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { ctx } from '@main/context'
import {
  listBackendConfigFiles as listConfigFiles,
  readBackendConfigFile as readConfigFile,
  resolveBackendConfigPath as resolveConfigPath,
  validateBackendConfigContent as validateConfigContent,
  writeBackendConfigFile as writeConfigFile,
} from '@main/service/backend-config-files'
import {
  cancelBackendInstall as cancelInstall,
  installBackend as runBackendInstall,
} from '@main/service/backend-installer'
import { logger } from '@main/service/logger'
import { getBackendConfigFileDescriptor } from '@shared/backend/config-files'
import type { BackendInstallResult } from '@shared/backend/install'
import type {
  AgentAnswer,
  ApprovalDecision,
  TurnConfigUpdate,
  WarmupBackendArgs,
} from '@shared/backend/types'
import { PUSH, type BackendId } from '@shared/constants'
import type { CoordinatedStartTurnArgs } from '@shared/ipc/backend'
import { shell } from 'electron'

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

// Backend Config Files: 直接编辑后端自己的本地配置文件。
// 全部按稳定 id 查表解析路径——renderer 传不进任意路径（见 service/backend-config-files.ts 顶部注释）。

export const listBackendConfigFiles = async () => {
  return listConfigFiles()
}

export const readBackendConfigFile = async (args: { id: string }) => {
  return readConfigFile(args.id)
}

export const writeBackendConfigFile = async (args: {
  id: string
  content: string
  expectedMtimeMs: number | null
  force?: boolean
}) => {
  return writeConfigFile(args)
}

export const validateBackendConfigFile = async (args: { id: string; content: string }) => {
  return validateConfigContent(args.id, args.content)
}

export const revealBackendConfigFile = async (args: { id: string }) => {
  const descriptor = getBackendConfigFileDescriptor(args.id)
  if (!descriptor) throw new Error(`未知的后端配置文件 id: ${args.id}`)
  const filePath = resolveConfigPath(descriptor)
  // 文件还没创建时 showItemInFolder 会 no-op，退化成打开所在目录
  if (existsSync(filePath)) {
    shell.showItemInFolder(filePath)
    return
  }
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  await shell.openPath(dir)
}
