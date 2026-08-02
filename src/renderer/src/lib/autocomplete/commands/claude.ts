/**
 * Composer Autocomplete: claude 后端的斜杠命令。
 *
 * 这些命令由 claude CLI 自己解释——catmax 只负责把 `/compact` 这行文本原样当
 * prompt 发过去（见 commands/types.ts 顶部）。所以这张表是一份**声明**，不是
 * 一份实现：加一条命令 = 在这里加一个对象，不需要碰任何执行路径。
 *
 * 为什么不从 SDK 动态拉：@anthropic-ai/claude-agent-sdk 的 query 对象上确实有
 * `supportedCommands(): Promise<SlashCommand[]>`（含内置命令 + .claude/commands/*.md
 * + skills），还有 SDKCommandsChangedMessage 会在会话中途推送变更。但那需要一个
 * **活着的 query 对象**，而 catmax 的 claude adapter 是 per-turn 建 query 的
 * （adapter.ts），空闲时根本没有连接。等确实需要用户自定义命令时，正确的做法是
 * 新开一条 IPC 把那份列表捞上来，然后在这张静态表之上做合并——provider 那侧
 * 已经只认 SlashCommandSpec[]，不关心它从哪来。
 */
import { ChartPieIcon, FilePlusIcon, FoldVerticalIcon } from 'lucide-vue-next'

import type { SlashCommandSpec } from './types'

export const CLAUDE_SLASH_COMMANDS: SlashCommandSpec[] = [
  {
    name: 'compact',
    description: '压缩当前对话为摘要，腾出上下文',
    // /compact 后面可以跟一句「摘要重点保留什么」，所以插入后补空格。
    argumentHint: '[保留重点]',
    icon: FoldVerticalIcon,
  },
  {
    name: 'init',
    description: '扫描代码库并生成 CLAUDE.md',
    icon: FilePlusIcon,
  },
  {
    name: 'context',
    description: '查看当前上下文占用明细',
    icon: ChartPieIcon,
  },
]
