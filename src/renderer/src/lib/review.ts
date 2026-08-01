/**
 * 审查面板的后端无关数据模型。
 *
 * 审查面板原本只服务 codex：codex 的 app-server 每轮下发 `file_change` 活动，
 * 里面已经是「这一轮对该文件的累计 unified diff」，面板直接渲染即可。
 * claude 没有这个东西——它只给一串 Edit/Write 工具调用，每个是独立的
 * old→new 片段，谁也不知道文件最终长什么样。
 *
 * 所以 ReviewFile 用两个互斥字段表达这个差异，而不是强行统一：
 *   - `diff`：整轮累计的 unified diff（codex）
 *   - `edits`：本轮对该文件的逐次编辑（claude），按调用顺序排列
 *
 * 面板据此分别渲染：前者一块 diff，后者一次编辑一块。想把 claude 的多次编辑
 * 合并成一个文件级 diff 是做不到的——中间状态没有落盘记录，除非去读磁盘上的
 * 当前文件，而那是「改完之后」的样子，不等于「这一轮改了什么」。
 */

import type { CodexFileChange } from '@shared/backend/blocks'
import { messageBlocks } from '@shared/backend/normalize-blocks'
import type { NormalizedMessage, ToolEditInfo } from '@shared/backend/types'

import { editDiffStats, type DiffStats } from './diff-stats'

export interface ReviewFile {
  /** 展示用路径。codex 给的就是相对路径；claude 给绝对路径，构建时相对 cwd 化。 */
  path: string
  kind: 'add' | 'delete' | 'update' | 'unknown'
  stats: DiffStats
  /** codex：整轮累计 unified diff */
  diff?: string
  /** claude：本轮对该文件的逐次编辑，按调用顺序 */
  edits?: ToolEditInfo[]
}

/** codex 的 file_change 结构上已经是 ReviewFile，转一层只为收窄到公共字段。 */
export function reviewFileFromCodexChange(change: CodexFileChange): ReviewFile {
  return {
    path: change.path,
    kind: change.kind,
    stats: change.stats,
    ...(change.diff ? { diff: change.diff } : {}),
  }
}

/**
 * 从一轮对话的消息里收集被编辑过的文件（claude 及任何走通用 tool_call 的后端）。
 *
 * 同一文件在一轮里被改多次会合并成一条：stats 累加，edits 按顺序追加。
 * 只认 `completed` 的调用——running 的编辑还没落盘，failed 的根本没改成，
 * 把它们算进"本轮改了什么"会给出一份对不上磁盘的清单。
 *
 * kind 的判定：整轮里出现过 full_content（Write/NotebookEdit）就算 add，
 * 否则 update。删除文件在 claude 里是 Bash `rm`，工具层看不出来，不做识别。
 */
export function buildReviewFilesFromMessages(
  messages: NormalizedMessage[],
  cwd?: string,
): ReviewFile[] {
  const byPath = new Map<string, ReviewFile>()

  for (const message of messages) {
    for (const block of messageBlocks(message)) {
      if (block.type !== 'tool_call') continue
      if (block.status !== 'completed') continue
      const edit = block.info.edit
      if (!edit) continue
      const stats = editDiffStats(edit)
      if (!stats) continue

      const path = relativeToCwd(edit.filePath || block.info.title, cwd)
      if (!path) continue

      const existing = byPath.get(path)
      if (existing) {
        existing.stats = {
          additions: existing.stats.additions + stats.additions,
          deletions: existing.stats.deletions + stats.deletions,
        }
        existing.edits!.push(edit)
        if (edit.type === 'full_content') existing.kind = 'add'
      } else {
        byPath.set(path, {
          path,
          kind: edit.type === 'full_content' ? 'add' : 'update',
          stats,
          edits: [edit],
        })
      }
    }
  }

  return [...byPath.values()]
}

/** 合计一组文件的增删——changes 卡片和审查面板头部共用。 */
export function sumReviewStats(files: ReviewFile[]): DiffStats {
  return files.reduce(
    (total, file) => ({
      additions: total.additions + file.stats.additions,
      deletions: total.deletions + file.stats.deletions,
    }),
    { additions: 0, deletions: 0 },
  )
}

/**
 * 绝对路径相对 cwd 化。
 *
 * claude 的工具入参一律是绝对路径，直接喂给审查面板的文件树会得到一串
 * `Users / shawn / Documents / …` 的无用层级。codex 那边天生是相对路径，
 * 相对化之后两个后端的树形状才一致。
 *
 * 不在 cwd 下的文件（改了工作区外的东西）保留原样——截断反而会让人以为
 * 它在工作区里。
 */
function relativeToCwd(filePath: string, cwd?: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  if (!cwd) return normalized
  const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!base) return normalized
  if (normalized === base) return normalized
  return normalized.startsWith(`${base}/`) ? normalized.slice(base.length + 1) : normalized
}
