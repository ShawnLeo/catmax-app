/**
 * Claude 专属内容块注册入口。
 *
 * 当前 Task/Web/PlanMode 仍由通用 tool_call 的结构化 payload 渲染；
 * 新增 Claude 独有 block 时只在这里注册。
 */
import { CLAUDE_CAPABILITIES } from '@shared/backend/builtin-capabilities'

import type { RendererBackendPlugin } from '../plugin-registry'
import { registerBlock } from '../registry'

export function registerClaudeBlocks(): void {
  // claude_tool_group 是渲染期合成的折叠块（见 shared/backend/blocks/claude.ts），
  // 不在 manifest.blockTypes 里，所以只注册渲染器、不参与 manifest 校验。
  registerBlock('claude_tool_group', () => import('./ClaudeToolGroupBlockView.vue'))
}

export const claudeRendererPlugin: RendererBackendPlugin = {
  manifest: {
    id: 'claude',
    displayName: 'Claude',
    version: '1',
    blockTypes: CLAUDE_CAPABILITIES.chat.blockTypes,
    capabilities: CLAUDE_CAPABILITIES,
  },
  registerBlocks: registerClaudeBlocks,
}
