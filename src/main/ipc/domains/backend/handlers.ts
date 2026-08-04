import { existsSync, mkdirSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

import { ctx } from '@main/context'
import { bridgeManager } from '@main/protocol/manager'
import { getCodec } from '@main/protocol/registry'
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
import { getStoredCredential, setStoredCredential } from '@main/service/bridge-credentials'
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
import type { BridgeStatus } from '@shared/protocol/bridge-config'
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

export const refreshModelsFor = async (args: { id: BackendId }) => {
  return ctx.backendManager.refreshModelsForBackend(args.id)
}

export const warmupBackend = async (args: { id: BackendId; config: WarmupBackendArgs }) => {
  await ctx.backendManager.warmupBackend(args.id, args.config)
}

export const slashCommands = async (args: { id: BackendId; cwd: string }) => {
  return ctx.backendManager.listSlashCommands(args.id, args.cwd)
}

export const startTurn = async (args: CoordinatedStartTurnArgs) => {
  return ctx.backendManager.startTurn(args)
}

export const interruptTurn = async (args: { turnId: string }) => {
  await ctx.backendManager.interruptTurn(args.turnId)
}

export const stopBackgroundTask = async (args: { taskId: string }) => {
  await ctx.backendManager.stopBackgroundTask(args.taskId)
}

/** 后台任务输出文件的默认尾部读取上限——面板只展示尾部，不需要整个构建日志。 */
const TASK_OUTPUT_MAX_BYTES = 64 * 1024

export const readBackgroundTaskOutput = async (args: {
  taskId: string
  outputFile: string
  maxBytes?: number
}) => {
  const empty = { exists: false, content: '', size: 0, truncated: false }
  // Background Tasks Panel: renderer 传来的路径不可信。SDK 的布局固定是
  // `<...>/tasks/<taskId>.output`，把路径钉死在这个形状上，越权读任意文件就无从谈起。
  const resolved = resolve(args.outputFile)
  if (basename(resolved) !== `${args.taskId}.output`) {
    log.warn('readBackgroundTaskOutput: path does not match task id', args.taskId)
    return empty
  }
  if (basename(dirname(resolved)) !== 'tasks') {
    log.warn('readBackgroundTaskOutput: path is not under a tasks/ dir', resolved)
    return empty
  }

  const maxBytes = Math.max(1, Math.min(args.maxBytes ?? TASK_OUTPUT_MAX_BYTES, 1024 * 1024))
  let handle: FileHandle | undefined
  try {
    handle = await open(resolved, 'r')
    const { size } = await handle.stat()
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    if (length <= 0) return { exists: true, content: '', size, truncated: false }
    const buffer = Buffer.allocUnsafe(length)
    await handle.read(buffer, 0, length, start)
    return { exists: true, content: buffer.toString('utf-8'), size, truncated: start > 0 }
  } catch {
    // 任务刚启动时文件可能还没建出来——这是正常状态，不是错误。
    return empty
  } finally {
    await handle?.close()
  }
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

// ---------------------------------------------------------------------------
// Protocol Bridge: 本机协议转换桥
// ---------------------------------------------------------------------------

export const getBridgeStatus = async (): Promise<BridgeStatus> => {
  return bridgeManager.status()
}

/**
 * 保存上游密钥。传空串即清除。
 *
 * 密钥只往一个方向走：renderer → 主进程 → userData 下 0600 的文件。
 * 反方向永远只回 status（含 credentialReady 布尔），密钥本身不回传。
 */
export const setBridgeCredential = async (args: {
  providerId: string
  secret: string
}): Promise<BridgeStatus> => {
  setStoredCredential(args.providerId, args.secret.trim())
  bridgeManager.invalidateModels()
  const status = bridgeManager.status()
  // 常见场景：codex 早于桥 spawn（启动时桥关着），没拿到 `-c model_provider` 参数。
  // 保存 key 是用户完成桥配置的时刻——桥此时若已在跑，借机让 codex 重 spawn 带上 -c。
  if (status.running && ctx.backendManager.getCurrentId() === 'codex') {
    void ctx.backendManager.reconnectBackend('codex')
  }
  return status
}

export const testBridgeUpstream = async (args: {
  providerId: string
}): Promise<{ ok: boolean; message: string }> => {
  const settings = ctx.settingsStore.load().protocolBridge
  const provider = settings.providers[args.providerId]
  if (!provider) return { ok: false, message: '配置不存在' }
  if (!provider.baseUrl.trim()) return { ok: false, message: '还没填上游地址' }

  // 取该 provider 的凭证做自检（env 读环境变量，stored 读 0600 文件）
  let apiKey: string | null = null
  if (provider.credentialSource === 'env') {
    const name = provider.credentialEnvVar.trim()
    apiKey = name ? process.env[name]?.trim() || null : null
  } else {
    apiKey = getStoredCredential(args.providerId)
  }
  if (!apiKey) {
    return {
      ok: false,
      message:
        provider.credentialSource === 'env'
          ? `环境变量 ${provider.credentialEnvVar || '(未填)'} 是空的`
          : '还没保存 API key',
    }
  }

  const codec = getCodec(provider.protocol)
  const base = provider.baseUrl.trim().replace(/\/+$/, '')
  const path = codec.upstreamPath()
  const url = base + (/\/v\d+$/.test(base) ? path.replace(/^\/v\d+/, '') : path)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...codec.authHeaders(apiKey, provider.authScheme),
      },
      body: JSON.stringify({
        model: provider.model?.trim() || 'claude-sonnet-4-20250514',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (response.ok) return { ok: true, message: `连通正常（HTTP ${response.status}）` }
    const detail = await response.text().catch(() => '')
    return { ok: false, message: `HTTP ${response.status}：${detail.slice(0, 300)}` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `请求失败：${message}` }
  }
}

export const bridgeCredentialReady = async (args: { providerId: string }): Promise<boolean> => {
  const settings = ctx.settingsStore.load().protocolBridge
  const provider = settings.providers[args.providerId]
  if (!provider) return false
  if (provider.credentialSource === 'env') {
    const name = provider.credentialEnvVar.trim()
    return name ? !!process.env[name]?.trim() : false
  }
  return getStoredCredential(args.providerId) !== null
}
