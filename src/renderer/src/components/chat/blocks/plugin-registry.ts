import type { BackendPluginManifest } from '@shared/backend/plugin'
import { validateBackendPluginManifest } from '@shared/backend/plugin'
import type { BackendId } from '@shared/constants'
import { defineAsyncComponent, type Component } from 'vue'

import { isBlockRegistered } from './registry'

type ConversationRendererLoader = () => Promise<{ default: Component }>

export interface RendererBackendPlugin {
  manifest: BackendPluginManifest
  registerBlocks: () => void
  /**
   * Optional backend-level composition root. Backends with a distinct conversation
   * grammar (Codex turns, for example) should not be forced through the base message shell.
   */
  conversationRenderer?: ConversationRendererLoader
}

const registry = new Map<BackendId, RendererBackendPlugin>()
const conversationRenderers = new Map<BackendId, Component>()

export function registerRendererBackendPlugin(plugin: RendererBackendPlugin): void {
  validateBackendPluginManifest(plugin.manifest)
  if (registry.has(plugin.manifest.id)) {
    throw new Error(`renderer backend plugin "${plugin.manifest.id}" is already registered`)
  }
  registry.set(plugin.manifest.id, plugin)
}

export function isRendererBackendPluginRegistered(id: BackendId): boolean {
  return registry.has(id)
}

export function getBackendConversationRenderer(id: BackendId): Component | null {
  const cached = conversationRenderers.get(id)
  if (cached) return cached
  const loader = registry.get(id)?.conversationRenderer
  if (!loader) return null
  const component = defineAsyncComponent({ loader, delay: 0, timeout: 10_000 })
  conversationRenderers.set(id, component)
  return component
}

export function registerRendererBackendBlocks(): void {
  for (const plugin of registry.values()) {
    plugin.registerBlocks()
    const missing = plugin.manifest.blockTypes.filter((type) => !isBlockRegistered(type))
    if (missing.length > 0) {
      console.warn(
        `[BackendPlugin] "${plugin.manifest.id}" has no renderer for: ${missing.join(', ')}`,
      )
    }
  }
}

export function clearRendererBackendPluginsForTest(): void {
  registry.clear()
  conversationRenderers.clear()
}
