/**
 * git domain IPC 契约。
 * 函数签名即契约——main 实现，renderer 通过 window.api 调用。
 *
 * 这些函数本体在 shared 里只声明签名（抛 Not Implemented），
 * 真实实现在 main/ipc/domains/git/handlers.ts。
 */

export interface FileChange {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'unknown'
  staged: boolean
}

export interface GitStatus {
  isRepo: boolean
  branch: string | null
  ahead: number
  behind: number
  staged: FileChange[]
  unstaged: FileChange[]
  untracked: string[]
  recentCommits: Commit[]
}

export interface Commit {
  hash: string
  shortHash: string
  author: string
  date: string
  message: string
}

// stub 参数名以 `_` 前缀避免 unused 报错；参数类型从 typeof 派生不受影响。
export async function getStatus(_args: { workspacePath: string }): Promise<GitStatus> {
  throw new Error('implemented in main')
}

/** 聚合类型：所有 git handler 的 channel → 签名映射 */
export type GitHandlers = {
  'git.status': typeof getStatus
}
