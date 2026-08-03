import type { BackendPluginManifest } from '@shared/backend/plugin'
import { validateBackendPluginManifest } from '@shared/backend/plugin'
import type { AgentBackend } from '@shared/backend/types'
import type { BackendId } from '@shared/constants'
import type { AppSettings } from '@shared/settings-schema'

export interface BackendPluginContext {
  onBackendThreadIdResolved: (backendId: BackendId, internalId: string, realId: string) => void
  /**
   * Unified Skill Center: adapter 报告「后端那边的技能集合变了」，由 manager 广播给
   * renderer 去重扫。adapter 不该自己碰 ctx.broadcast——那会让它依赖窗口层。
   */
  onSkillsChanged: (backendId: BackendId) => void
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
