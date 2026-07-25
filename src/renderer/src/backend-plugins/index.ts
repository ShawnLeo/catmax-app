import { claudeRendererPlugin } from '../components/chat/blocks/claude'
import { codexRendererPlugin } from '../components/chat/blocks/codex'
import {
  isRendererBackendPluginRegistered,
  registerRendererBackendPlugin,
} from '../components/chat/blocks/plugin-registry'

/** Renderer plugin composition root. Add trusted bundled plugin registrations here. */
export function registerRendererBackendPlugins(): void {
  if (!isRendererBackendPluginRegistered('claude')) {
    registerRendererBackendPlugin(claudeRendererPlugin)
  }
  if (!isRendererBackendPluginRegistered('codex')) {
    registerRendererBackendPlugin(codexRendererPlugin)
  }
}
