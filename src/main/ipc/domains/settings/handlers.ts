import { ctx } from '@main/context'
import { logger } from '@main/service/logger'
import type { AppSettings } from '@shared/settings-schema'

const log = logger.domain('settings-handler')

export const getSettings = async (): Promise<AppSettings> => {
  return ctx.settingsStore.load()
}

export const updateSettings = async (args: {
  patch: Partial<AppSettings>
}): Promise<AppSettings> => {
  const updated = ctx.settingsStore.update(args.patch)
  // settings 变了——重新 apply 到 BackendManager，让代理/binaryPath 等立即生效。
  // 特别注意：codex 的 app-server 是 long-running 进程，已经 spawn 出去的进程
  // 不会读到新 env。applySettings 会更新 adapter 内部状态，但下次 spawn 才生效。
  // 对 codex 来说，用户改代理后需要重新切一次 backend（dispose + 重新 initialize）
  // 才能用新代理。这里不自动 dispose——由用户在 UI 上重连。
  try {
    ctx.backendManager.applySettings(updated)
  } catch (e) {
    log.warn('applySettings after update failed:', e)
  }
  return updated
}

export const resetSettings = async (): Promise<AppSettings> => {
  const reset = ctx.settingsStore.reset()
  try {
    ctx.backendManager.applySettings(reset)
  } catch (e) {
    log.warn('applySettings after reset failed:', e)
  }
  return reset
}
