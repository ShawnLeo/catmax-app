/**
 * Markdown 引擎公共入口。
 *
 * 这里仅重新导出 base 实例的 API,目的是「向后兼容」——
 * 现有大量 `import { renderMarkdown } from '@renderer/lib/markdown'` 在拆分后
 * 无需改动,自动指向 base 引擎（FilePreview / 旧调用点等跨后端共用场景）。
 *
 * 后端专属路径请直接 import 子模块:
 * - Codex: `@renderer/lib/markdown/codex`
 * - Claude: `@renderer/lib/markdown/claude`（当前等价于 base）
 *
 * 详见 `./create-markdown.ts` 顶部架构注释。
 */
export { baseMarkdown } from './base'
export { renderMarkdown, renderMarkdownSync, getMarkdown, prewarmMarkdown } from './base'
export type { MarkdownInstance, MarkdownInstanceOptions } from './create-markdown'
export { createMarkdownInstance } from './create-markdown'
