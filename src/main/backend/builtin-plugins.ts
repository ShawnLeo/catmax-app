import { CLAUDE_CAPABILITIES, CODEX_CAPABILITIES } from '@shared/backend/builtin-capabilities'

import { bridgeManager } from '../protocol/manager'

import { ClaudeAdapter } from './claude/adapter'
import { CodexAdapter } from './codex/adapter'
import {
  getBackendPlugins,
  registerBackendPlugin,
  type BackendPluginContext,
} from './plugin-registry'
import { proxySettingsToEnv } from './proxy-env'

export function registerBuiltinBackendPlugins(): void {
  const registered = new Set(getBackendPlugins().map((plugin) => plugin.manifest.id))

  if (!registered.has('codex')) {
    registerBackendPlugin({
      manifest: {
        id: 'codex',
        displayName: 'Codex',
        version: '1',
        blockTypes: CODEX_CAPABILITIES.chat.blockTypes,
        capabilities: CODEX_CAPABILITIES,
      },
      createAdapter: () => new CodexAdapter(),
      applySettings: (adapter, settings) => {
        if (!(adapter instanceof CodexAdapter)) return
        const binaryPath = settings.backendPaths.codex
        if (binaryPath) {
          const changed = adapter.getBinaryPath() !== binaryPath
          adapter.setBinaryPath(binaryPath)
          if (changed) adapter.invalidateModelsCache()
        }
        // Protocol Bridge: 桥开着时把 codex 的 model_provider 用 `-c` 覆盖到本机桥上，
        // 并注入桥的 token。桥关着时两者都是空，codex 完全按用户自己的 config.toml 走。
        // 桥跑在 127.0.0.1，代理必须放行本机——否则 codex 经代理访问桥会 502。
        const bridgeActive = bridgeManager.status().running
        adapter.setExtraEnv({
          ...proxySettingsToEnv(settings.httpProxy, {
            ensureLocalhostBypassed: bridgeActive,
          }),
          ...bridgeManager.codexSpawnEnv(),
        })
        adapter.setExtraArgs(bridgeManager.codexSpawnArgs())
        // 老会话的 provider 写死在 rollout 里，`-c model_provider` 覆盖不了它——
        // resume 时必须显式传（详见 CodexAdapter.setModelProvider）。
        adapter.setModelProvider(bridgeManager.codexModelProviderId())
        // 桥开着时模型列表必须来自上游——codex 的 model/list 是写死的 ChatGPT 目录，
        // 跟当前 model_provider 无关（详见 CodexAdapter.setModelListProvider）。
        adapter.setModelListProvider(
          settings.protocolBridge.enabled
            ? {
                list: async () => {
                  const models = await bridgeManager.listUpstreamModels()
                  if (models.length === 0) return []
                  // 默认项优先用当前 provider 的兜底模型；不在上游列表就退到第一个
                  const currentId = settings.protocolBridge.currentProviderId
                  const provider = settings.protocolBridge.providers[currentId]
                  const fallback = provider?.model?.trim()
                  const defaultId =
                    fallback && models.some((m) => m.id === fallback) ? fallback : models[0]!.id
                  return models.map((model) => ({
                    id: model.id,
                    displayName: model.displayName,
                    ...(model.id === defaultId ? { isDefault: true } : {}),
                  }))
                },
                invalidate: () => bridgeManager.invalidateModels(),
              }
            : null,
        )
      },
    })
  }

  if (!registered.has('claude')) {
    registerBackendPlugin({
      manifest: {
        id: 'claude',
        displayName: 'Claude',
        version: '1',
        blockTypes: CLAUDE_CAPABILITIES.chat.blockTypes,
        capabilities: CLAUDE_CAPABILITIES,
      },
      createAdapter: (context: BackendPluginContext) =>
        new ClaudeAdapter({
          onRealSessionId: (internalId, realId) =>
            context.onBackendThreadIdResolved('claude', internalId, realId),
        }),
      applySettings: (adapter, settings) => {
        if (!(adapter instanceof ClaudeAdapter)) return
        const binaryPath = settings.backendPaths.claude
        if (binaryPath) adapter.setBinaryPath(binaryPath)
        adapter.setExtraEnv(proxySettingsToEnv(settings.httpProxy))
      },
    })
  }
}
