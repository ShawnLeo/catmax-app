import type { BaseContentBlock } from './base'

/** Codex app-server 的 plan item。 */
export interface PlanContentBlock extends BaseContentBlock {
  type: 'plan'
  text: string
}

/**
 * Codex `ThreadItem.userMessage.content[]` 中除纯文本外的输入。
 *
 * App Server 当前公开 text/image/localImage/skill/mention。历史 rollout 导入还可能只留下
 * “Files mentioned by the user” 文本包装；main 端会把它恢复为这里的 image/file block，
 * renderer 不需要理解协议包装文本。
 */
export interface CodexUserInputContentBlock extends BaseContentBlock {
  type: 'codex_user_input'
  kind: 'image' | 'file' | 'skill' | 'mention'
  name?: string
  path?: string
  /** `image.url`，可能是 https URL 或持久化在历史中的 data URL。 */
  url?: string
  detail?: string
}

/** Codex 图像工具生成并持久化到 rollout 的图片。 */
export interface CodexGeneratedImageContentBlock extends BaseContentBlock {
  type: 'codex_generated_image'
  /** 无本地文件时使用的 data URL。 */
  url?: string
  /** Codex 同时保存的本地文件路径，用于展示文件名和未来的文件操作。 */
  path?: string
}

export type CodexActivityStatus = 'running' | 'completed' | 'failed'

export interface CodexDiffStats {
  additions: number
  deletions: number
}

export interface CodexFileChange {
  path: string
  kind: 'add' | 'delete' | 'update' | 'unknown'
  movePath?: string
  diff?: string
  stats: CodexDiffStats
}

interface CodexActivityBase {
  id: string
  status: CodexActivityStatus
  durationMs?: number
}

export interface CodexCommandActivity extends CodexActivityBase {
  kind: 'command'
  command: string
  cwd?: string
  output?: string
}

export interface CodexFileReadActivity extends CodexActivityBase {
  kind: 'file_read'
  path: string
  name?: string
  command: string
}

export interface CodexFileListActivity extends CodexActivityBase {
  kind: 'file_list'
  path?: string
  command: string
}

export interface CodexSearchActivity extends CodexActivityBase {
  kind: 'search'
  query?: string
  path?: string
  command: string
}

export interface CodexFileChangeActivity extends CodexActivityBase {
  kind: 'file_change'
  changes: CodexFileChange[]
}

export interface CodexToolActivity extends CodexActivityBase {
  kind: 'mcp' | 'dynamic_tool' | 'collab_tool' | 'web_search' | 'image_view'
  title: string
  detail?: string
}

export type CodexActivity =
  | CodexCommandActivity
  | CodexFileReadActivity
  | CodexFileListActivity
  | CodexSearchActivity
  | CodexFileChangeActivity
  | CodexToolActivity

/**
 * Codex 专属“工作过程”块。
 *
 * 历史回放默认折叠；实时块保持展开，并通过 itemId 原位更新命令状态与 diff 统计。
 */
export interface CodexActivityContentBlock extends BaseContentBlock {
  type: 'codex_activity'
  status: CodexActivityStatus
  activities: CodexActivity[]
  defaultCollapsed?: boolean
  durationMs?: number
  turnDiff?: string
  turnDiffStats?: CodexDiffStats
}
