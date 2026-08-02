/**
 * Composer Autocomplete: claude 的**静态兜底**斜杠命令表。
 *
 * 正常情况下这张表会被 SDK 拉来的真实列表整表替换（见 index.ts 的
 * registerSlashCommands + stores/slash-commands.ts 的预取）。它只在这些时候露面：
 *   - 预取还没回来（冷启握手实测 2.1–2.6 秒）
 *   - claude 没装 / 握手失败
 *
 * 所以选的是三条**最常用且最稳定**的：拉不到列表时用户至少还能用它们，
 * 而不是对着一个空弹层。真实列表到手后这张表就完全不参与了。
 *
 * 这些命令由 claude CLI 自己解释——catmax 只负责把 `/compact` 这行文本原样当
 * prompt 发过去（见 commands/types.ts 顶部）。
 */
import { ChartPieIcon, FilePlusIcon, FoldVerticalIcon } from 'lucide-vue-next'

import type { SlashCommandSpec } from './types'

export const CLAUDE_FALLBACK_COMMANDS: SlashCommandSpec[] = [
  {
    name: 'compact',
    description: '压缩当前对话为摘要，腾出上下文',
    // /compact 后面可以跟一句「摘要重点保留什么」，所以插入后补空格。
    argumentHint: '[保留重点]',
    source: 'builtin',
    icon: FoldVerticalIcon,
  },
  {
    name: 'init',
    description: '扫描代码库并生成 CLAUDE.md',
    source: 'builtin',
    icon: FilePlusIcon,
  },
  {
    name: 'context',
    description: '查看当前上下文占用明细',
    source: 'builtin',
    icon: ChartPieIcon,
  },
]
