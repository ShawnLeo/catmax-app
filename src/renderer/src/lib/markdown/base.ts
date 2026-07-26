/**
 * Base markdown 引擎实例。
 *
 * 这是「默认/兜底」实现,服务于：
 * - Claude 后端（直接复用 base,真要分叉时再 `cp base.ts claude.ts`）
 * - 跨后端共用组件（FilePreview / ThinkingBlock / ToolCallCard / WebCard / ExitPlanModeCard）
 * - 旧 import 路径 `@renderer/lib/markdown`（通过 `index.ts` 重导出,向后兼容）
 *
 * 配置与拆分前完全等价,行为不变。
 */
import { createMarkdownInstance } from './create-markdown'

export const baseMarkdown = createMarkdownInstance()

export const { getMarkdown, renderMarkdown, renderMarkdownSync, prewarmMarkdown } = baseMarkdown
