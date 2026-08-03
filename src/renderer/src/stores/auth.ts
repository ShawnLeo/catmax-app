import type { AuthStatus, LoginMethod } from '@shared/ipc/auth'
import { INTERNAL_BETA_PROVIDER_ID } from '@shared/protocol/bridge-config'
import { defineStore } from 'pinia'
import { ref } from 'vue'

import { useSettingsStore } from './settings'

/**
 * 内测登录态 store。
 *
 * 关键设计：ensureInitialized() 缓存首次 IPC getStatus 的 promise，
 * 路由守卫在每次导航时都能安全地 await 它，且只会在首次真实发起一次 IPC。
 * 这样守卫既能拿到登录态又不会重复请求。
 *
 * Internal Beta Login: settings 的真相源在 renderer——login 后由这里调
 * settings.update 写 protocolBridge（启用桥 + 内测 provider），logout 后清掉。
 * 这样走 IPC 单一链路，settings store 自动刷新 → 设置页 UI 立即显示 provider。
 * 密钥本身不经过 renderer（已由 main 存进 0600 bridge-credentials 文件）。
 */
export const useAuthStore = defineStore('auth', () => {
  const loggedIn = ref(false)
  const loginMethod = ref<LoginMethod | null>(null)
  /** 是否已从主进程同步过初始登录态（守卫依赖它判断是否需要等待） */
  const initialized = ref(false)

  let initPromise: Promise<void> | null = null

  /** 从主进程拉取登录态；重复调用返回同一个 promise（守卫可安全 await）。 */
  function ensureInitialized(): Promise<void> {
    if (initPromise) return initPromise
    initPromise = (async () => {
      const status = await window.api.auth.getStatus()
      applyStatus(status)
      initialized.value = true
    })()
    return initPromise
  }

  function applyStatus(status: AuthStatus): void {
    loggedIn.value = status.loggedIn
    loginMethod.value = status.loginMethod
  }

  /**
   * Internal Beta Login: 应用内测桥配置到 settings.protocolBridge。
   * 在 settings store 已加载的前提下，把内测 provider 写进 providers、设为当前、启用桥。
   */
  function applyInternalBetaBridge(provider: AuthStatus['internalBetaBridge']): void {
    if (!provider) return
    const settings = useSettingsStore()
    if (!settings.settings) return
    const protocolBridge = {
      ...settings.settings.protocolBridge,
      enabled: true,
      currentProviderId: INTERNAL_BETA_PROVIDER_ID,
      providers: {
        ...settings.settings.protocolBridge.providers,
        [INTERNAL_BETA_PROVIDER_ID]: provider.provider,
      },
    }
    void settings.update({ protocolBridge })
  }

  /**
   * Internal Beta Login: 清除内测桥配置（logout 时）。
   * 移除内测 provider；若它是当前 provider 则清空；删完无 provider 则关桥。
   */
  function clearInternalBetaBridge(): void {
    const settings = useSettingsStore()
    if (!settings.settings) return
    const providers = { ...settings.settings.protocolBridge.providers }
    delete providers[INTERNAL_BETA_PROVIDER_ID]
    const wasCurrent =
      settings.settings.protocolBridge.currentProviderId === INTERNAL_BETA_PROVIDER_ID
    const currentProviderId = wasCurrent ? '' : settings.settings.protocolBridge.currentProviderId
    const enabled = Object.keys(providers).length > 0 && settings.settings.protocolBridge.enabled
    void settings.update({
      protocolBridge: {
        ...settings.settings.protocolBridge,
        enabled,
        currentProviderId,
        providers,
      },
    })
  }

  /**
   * 密钥登录。内测阶段主进程不做真实校验（非空即成功）。
   * 成功后：本地态更新 + 把内测桥 provider 写进 settings（走 IPC 刷新 UI + 启动桥）。
   */
  async function login(secretKey: string): Promise<AuthStatus> {
    const status = await window.api.auth.login({ secretKey })
    applyStatus(status)
    // main 已存好密钥 + 写好 Claude 覆盖；这里把桥 provider 写进 settings，
    // settings.update IPC 会落盘 + main handler 会启动桥，renderer store 也同步刷新。
    applyInternalBetaBridge(status.internalBetaBridge)
    return status
  }

  /** 退出登录：清除主进程登录态 + 本地态 + 清桥 settings。 */
  async function logout(): Promise<void> {
    await window.api.auth.logout()
    const status: AuthStatus = { loggedIn: false, loginMethod: null }
    applyStatus(status)
    clearInternalBetaBridge()
  }

  return { loggedIn, loginMethod, initialized, ensureInitialized, login, logout }
})
