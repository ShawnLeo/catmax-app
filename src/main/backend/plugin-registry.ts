import type { BackendPluginManifest } from '@shared/backend/plugin'
import { validateBackendPluginManifest } from '@shared/backend/plugin'
import type { AgentBackend } from '@shared/backend/types'
import type { BackendId } from '@shared/constants'
import type { AppSettings } from '@shared/settings-schema'

export interface BackendPluginContext {
  onBackendThreadIdResolved: (backendId: BackendId, internalId: string, realId: string) => void
}

export interface MainBackendPlugin {
  manifest: BackendPluginManifest
  createAdapter: (context: BackendPluginContext) => AgentBackend
  applySettings?: (adapter: AgentBackend, settings: AppSettings) => void
}

const registry = new Map<BackendId, MainBackendPlugin>()

export function registerBackendPlugin(plugin: MainBackendPlugin): void {
  validateBackendPluginManifest(plugin.manifest)
  if (registry.has(plugin.manifest.id)) {
    throw new Error(`backend plugin "${plugin.manifest.id}" is already registered`)
  }
  registry.set(plugin.manifest.id, plugin)
}

export function getBackendPlugins(): MainBackendPlugin[] {
  return [...registry.values()]
}

export function isBackendPluginRegistered(id: BackendId): boolean {
  return registry.has(id)
}

export function clearBackendPluginsForTest(): void {
  registry.clear()
}
