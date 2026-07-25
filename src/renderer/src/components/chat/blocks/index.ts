import { registerRendererBackendPlugins } from '@renderer/backend-plugins'

import { registerBaseBlocks } from './base'
import { registerRendererBackendBlocks } from './plugin-registry'

export function registerChatBlocks(): void {
  registerBaseBlocks()
  registerRendererBackendPlugins()
  registerRendererBackendBlocks()
}
