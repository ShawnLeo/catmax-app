/**
 * Codex 后端专属 markdown 引擎实例。
 *
 * 当前配置与 base 完全一致（拆分第一阶段保证行为不变）。
 * 后续若需要 Codex 独有的 markdown-it 插件、Shiki 主题或 fence 渲染规则,
 * 在此处通过 `createMarkdownInstance(options)` 传入不同的 options 即可,
 * 不会影响 base / claude。
 *
 * 配套组件：`src/renderer/src/components/chat/blocks/codex/MarkdownView.vue`
 */
import { createMarkdownInstance } from './create-markdown'

export const codexMarkdown = createMarkdownInstance()

export const {
  getMarkdown: getCodexMarkdown,
  renderMarkdown: renderCodexMarkdown,
  renderMarkdownSync: renderCodexMarkdownSync,
  prewarmMarkdown: prewarmCodexMarkdown,
} = codexMarkdown
