/**
 * Claude 后端专属 markdown 引擎入口。
 *
 * 当前 Claude 的渲染行为与 base 完全一致,直接复用 base 实例——
 * 避免无意义的实例复制（多一份 Shiki 初始化约几百毫秒,纯属浪费）。
 *
 * 真要为 Claude 配置独立插件链/主题时,把这里的 `baseMarkdown` 换成
 * `createMarkdownInstance(options)` 即可,所有 Claude 路径自动切到新实例。
 *
 * 该文件的存在主要是为了「结构对称」——让 `lib/markdown/{base,codex,claude}.ts`
 * 三件套齐全,新增后端时一眼能看出模式。
 */
import { baseMarkdown } from './base'

export const claudeMarkdown = baseMarkdown

export const {
  getMarkdown: getClaudeMarkdown,
  renderMarkdown: renderClaudeMarkdown,
  renderMarkdownSync: renderClaudeMarkdownSync,
  prewarmMarkdown: prewarmClaudeMarkdown,
} = claudeMarkdown
