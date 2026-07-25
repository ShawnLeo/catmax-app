import { CODEX_CAPABILITIES } from '@shared/backend/builtin-capabilities'

import type { RendererBackendPlugin } from '../plugin-registry'
import { registerBlock } from '../registry'

/** Codex app-server 专属内容块。 */
export function registerCodexBlocks(): void {
  registerBlock('plan', () => import('./PlanBlockView.vue'))
  registerBlock('codex_user_input', () => import('./CodexUserInputBlockView.vue'))
  registerBlock('codex_activity', () => import('./CodexActivityBlockView.vue'))
}

export const codexRendererPlugin: RendererBackendPlugin = {
  manifest: {
    id: 'codex',
    displayName: 'Codex',
    version: '1',
    blockTypes: CODEX_CAPABILITIES.chat.blockTypes,
    capabilities: CODEX_CAPABILITIES,
  },
  registerBlocks: registerCodexBlocks,
  conversationRenderer: () => import('./CodexConversation.vue'),
}
