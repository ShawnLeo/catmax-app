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
  // 桥开关翻转要重连 codex——它的 -c 参数依赖桥的端口/token，
  // 已 spawn 的进程读不到新值。必须在 update 前快照旧值才能 diff。
  const wasBridgeEnabled = ctx.settingsStore.load().protocolBridge.enabled
  const updated = ctx.settingsStore.update(args.patch)
  // settings 变了——重新 apply 到 BackendManager，让代理/binaryPath 等立即生效。
  // applyBridgeThenBackend 先起桥、再把桥的 spawn 参数写进 codex adapter（setExtraArgs），
  // 所以必须先于 reconnectBackend——否则重 spawn 时 extraArgs 还是旧的。
  await applyBridgeThenBackend(updated)
  // 桥开关翻转（开↔关）改变了 codexSpawnArgs 的返回（空数组 ↔ 有 -c），
  // 当前后端是 codex 时必须重 spawn 才能让 codex 指向/脱离本机桥。
  if (
    updated.protocolBridge.enabled !== wasBridgeEnabled &&
    ctx.backendManager.getCurrentId() === 'codex'
  ) {
    await ctx.backendManager.reconnectBackend('codex')
  }
  return updated
}

export const resetSettings = async (): Promise<AppSettings> => {
  const reset = ctx.settingsStore.reset()
  await applyBridgeThenBackend(reset)
  return reset
}
