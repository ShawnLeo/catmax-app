import { registerBlock } from '../registry'

/** 所有 backend 共享的最小渲染集合。 */
export function registerBaseBlocks(): void {
  registerBlock('text', () => import('./TextBlockView.vue'))
  registerBlock('reasoning', () => import('./ReasoningBlockView.vue'))
  registerBlock('tool_call', () => import('./ToolCallBlockView.vue'))
  registerBlock('context', () => import('./ContextBlockView.vue'), 'hide')
  registerBlock('compact_divider', () => import('./CompactDividerBlockView.vue'))
}
