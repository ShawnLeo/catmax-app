/**
 * Protocol Bridge 生命周期管理：设置 ↔ HTTP 服务 ↔ codex spawn 参数。
 *
 * codex 侧的接管方式是**spawn 时用 `-c key=value` 覆盖**，不改用户的 config.toml：
 *   codex app-server
 *     -c model_provider="catmax-bridge"
 *     -c model_providers.catmax-bridge.base_url="http://127.0.0.1:<port>/v1"
 *     -c model_providers.catmax-bridge.wire_api="responses"
 *     -c model_providers.catmax-bridge.env_key="CATMAX_BRIDGE_TOKEN"
 * 加上环境变量 CATMAX_BRIDGE_TOKEN=<桥的一次性 token>。
 *
 * 这样做的三个好处：完全可逆（关掉桥就是不传参数）、不动用户文件、
 * 以及**上游的真 key 从不进 codex 的环境或配置**——codex 拿到的只是桥的 token。
 */
import {
  BRIDGE_CODEX_PROVIDER_ID,
  BRIDGE_TOKEN_ENV_VAR,
  type BridgeModelInfo,
  type BridgeProvider,
  type BridgeSettings,
  type BridgeStatus,
  type BridgeUpstreamConfig,
} from '@shared/protocol/bridge-config'

import { getStoredCredential } from '../service/bridge-credentials'
import { logger } from '../service/logger'

import type { BridgeUpstreamTarget } from './bridge'
import { BridgeServer } from './server'
import { fetchUpstreamModels } from './upstream-models'

const log = logger.domain('bridge-manager')

export class BridgeManager {
  private settings: BridgeSettings | null = null
  private readonly server = new BridgeServer({
    resolveUpstream: () => this.resolveUpstream(),
  })

  /** 当前激活的 provider；未选/不存在时返回 null */
  private currentProvider(): BridgeProvider | null {
    const s = this.settings
    if (!s) return null
    const id = s.currentProviderId
    if (!id) return null
    return s.providers[id] ?? null
  }

  /** settings 变化时调用：按 enabled 起停服务 */
  async applySettings(settings: BridgeSettings): Promise<void> {
    const wasEnabled = this.settings?.enabled ?? false
    const prevCurrent = this.currentProvider() // 切换前的当前 provider 快照
    this.settings = settings
    const newCurrent = this.currentProvider()

    // 当前 provider 的「身份」变了（地址/列表/凭证来源/模型列表模式/手填列表）就丢模型缓存
    if (
      (prevCurrent && newCurrent && upstreamModelIdentityChanged(prevCurrent, newCurrent)) ||
      (!prevCurrent && newCurrent)
    ) {
      this.invalidateModels()
    }

    if (settings.enabled && !wasEnabled) {
      try {
        await this.server.start()
      } catch (error) {
        log.warn('桥启动失败', error instanceof Error ? error.message : String(error))
      }
      return
    }
    if (!settings.enabled && wasEnabled) {
      await this.server.stop()
    }
  }

  async stop(): Promise<void> {
    await this.server.stop()
  }

  /**
   * 解析当前上游目标。返回 null 表示配置不完整，server 会回 503 并给出人话提示。
   * 每次请求都重新解析——用户改了设置不用重启桥。
   */
  private resolveUpstream(): BridgeUpstreamTarget | null {
    const upstream = this.currentProvider()
    if (!this.settings?.enabled || !upstream) return null
    if (!upstream.baseUrl.trim()) return null

    const apiKey = this.resolveCredential()
    if (!apiKey) return null

    return {
      protocol: upstream.protocol,
      baseUrl: upstream.baseUrl.trim(),
      apiKey,
      model: upstream.model?.trim() ? upstream.model.trim() : null,
      knownModelIds: this.knownModelIds,
      capabilities: upstream.capabilities,
    }
  }

  // ============ 上游模型列表 ============

  /**
   * 上游模型列表。缓存的是 Promise，并发调用共享同一次请求；失败时清缓存以便重试。
   * 和 CodexAdapter.listModels 的缓存策略保持一致。
   */
  private modelsPromise: Promise<BridgeModelInfo[]> | null = null
  /** 最后一次成功的结果，供 resolveUpstream 同步读取 */
  private knownModelIds: ReadonlySet<string> | null = null

  async listUpstreamModels(): Promise<BridgeModelInfo[]> {
    // manual 模式不进缓存：手填列表随时可变，每次重读保证即时生效
    const provider = this.currentProvider()
    if (!provider) return []

    if (provider.modelListMode === 'manual') {
      const models = provider.manualModels
        .map((id) => id.trim())
        .filter((id) => id)
        .map((id) => ({ id, displayName: id }))
      // 手填列表也要喂给 knownModelIds——resolveModel 据此判断透传还是兜底
      this.knownModelIds = new Set(models.map((m) => m.id))
      return models
    }

    // auto 模式：缓存命中优先
    if (this.modelsPromise) return this.modelsPromise
    if (!this.settings?.enabled) return []
    const { baseUrl, modelsUrl } = provider
    const apiKey = this.resolveCredential()
    if (!apiKey) return []

    this.modelsPromise = (async () => {
      try {
        const models = await fetchUpstreamModels({ modelsUrl, baseUrl, apiKey })
        this.knownModelIds = new Set(models.map((m) => m.id))
        return models
      } catch (error) {
        this.modelsPromise = null
        log.warn('拉取上游模型列表失败', error instanceof Error ? error.message : String(error))
        return []
      }
    })()
    return this.modelsPromise
  }

  /** 清模型缓存；下次 listUpstreamModels 会重新拉 */
  invalidateModels(): void {
    this.modelsPromise = null
    this.knownModelIds = null
  }

  private resolveCredential(): string | null {
    const provider = this.currentProvider()
    if (!provider) return null
    if (provider.credentialSource === 'env') {
      const name = provider.credentialEnvVar.trim()
      if (!name) return null
      const value = process.env[name]?.trim()
      return value ? value : null
    }
    return getStoredCredential(provider.id)
  }

  /** 凭证是否就绪——只回 boolean，密钥本身不出这个类 */
  credentialReady(): boolean {
    return this.resolveCredential() !== null
  }

  /**
   * 取出凭证明文，**仅供主进程内的连通性自检使用**。
   * 调用方必须保证结果不进 IPC、不进日志。
   */
  probeCredential(): string | null {
    return this.resolveCredential()
  }

  status(): BridgeStatus {
    const provider = this.currentProvider()
    return {
      running: this.server.running,
      port: this.server.listenPort,
      baseUrl: this.server.baseUrl,
      currentProviderId: provider?.id ?? null,
      upstreamProtocol: provider?.protocol ?? null,
      upstreamBaseUrl: provider?.baseUrl ?? null,
      credentialReady: this.credentialReady(),
      lastError: this.server.error,
    }
  }

  /**
   * spawn codex 时要追加的参数。桥没跑就返回空数组——
   * 空数组意味着 codex 完全按用户自己的 config.toml 走，和没装过 catmax 一样。
   */
  codexSpawnArgs(): string[] {
    const baseUrl = this.server.baseUrl
    if (!this.settings?.enabled || !baseUrl) return []
    const provider = BRIDGE_CODEX_PROVIDER_ID
    return [
      // 桥接管 model_provider 后，上游是 DeepSeek/Anthropic 等，不再是 ChatGPT。
      // codex 0.145+ 的 `apps` feature 会内置一个 codex_apps MCP，它连 ChatGPT 远程
      // 服务——用户没 codex login 时它启动超时 30s 才失败，期间阻塞 turn 实际执行
      // （实测：首个 token 延迟从 1s 飙到 30s+）。桥场景下它毫无用处，直接禁用。
      '--disable',
      'apps',
      '-c',
      `model_provider="${provider}"`,
      '-c',
      `model_providers.${provider}.name="catmax protocol bridge"`,
      '-c',
      `model_providers.${provider}.base_url="${baseUrl}"`,
      '-c',
      `model_providers.${provider}.wire_api="responses"`,
      '-c',
      `model_providers.${provider}.env_key="${BRIDGE_TOKEN_ENV_VAR}"`,
      // 桥在本机，重试交给桥自己处理，codex 不要再叠一层
      '-c',
      `model_providers.${provider}.request_max_retries=0`,
    ]
  }

  /** spawn codex 时要注入的环境变量：桥的 token（**不是**上游真 key） */
  codexSpawnEnv(): Record<string, string> {
    if (!this.settings?.enabled || !this.server.running) return {}
    return { [BRIDGE_TOKEN_ENV_VAR]: this.server.authToken }
  }
}

/**
 * 影响「模型列表是哪个上游的」的字段变了没有。
 * 改能力开关（supportsImages 等）不该丢缓存；但地址/列表/凭证来源/模型列表模式/手填列表变了要丢。
 */
function upstreamModelIdentityChanged(a: BridgeUpstreamConfig, b: BridgeUpstreamConfig): boolean {
  return (
    a.modelsUrl !== b.modelsUrl ||
    a.baseUrl !== b.baseUrl ||
    a.credentialSource !== b.credentialSource ||
    a.credentialEnvVar !== b.credentialEnvVar ||
    a.modelListMode !== b.modelListMode ||
    // manualModels 按内容比（引用不同但内容相同不该失效）
    a.manualModels.join('\n') !== b.manualModels.join('\n')
  )
}

/**
 * 全局单例。
 *
 * 单独 export 而不是挂在 ctx 上，是为了让 backend/builtin-plugins.ts 能直接引用而
 * 不引入 `backend → context → backend` 的循环依赖。本模块只依赖 shared 和 service，
 * 不碰 backend 层。
 */
export const bridgeManager = new BridgeManager()
