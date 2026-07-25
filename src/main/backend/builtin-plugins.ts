import { CLAUDE_CAPABILITIES, CODEX_CAPABILITIES } from '@shared/backend/builtin-capabilities'

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
        adapter.setExtraEnv(proxySettingsToEnv(settings.httpProxy))
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
