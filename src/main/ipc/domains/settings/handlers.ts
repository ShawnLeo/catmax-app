import { ctx } from '@main/context'
import { bridgeManager } from '@main/protocol/manager'
import { logger } from '@main/service/logger'
import type { AppSettings } from '@shared/settings-schema'

const log = logger.domain('settings-handler')

/**
 * Protocol Bridge: 必须先 apply 桥再 apply backend。
 * codex 的启动参数里带着桥的端口和 token，桥还没监听起来的话拿到的是空值。
 */
async function applyBridgeThenBackend(settings: AppSettings): Promise<void> {
  try {
    await bridgeManager.applySettings(settings.protocolBridge)
  } catch (e) {
    log.warn('bridge applySettings failed:', e)
  }
  try {
    ctx.backendManager.applySettings(settings)
  } catch (e) {
    log.warn('applySettings failed:', e)
  }
}

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
  await applyBridgeThenBackend(updated)
  return updated
}

export const resetSettings = async (): Promise<AppSettings> => {
  const reset = ctx.settingsStore.reset()
  await applyBridgeThenBackend(reset)
  return reset
}
