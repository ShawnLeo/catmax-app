/**
 * Git 服务（只读）—— 用 simple-git 封装。
 *
 * 所有方法都不修改 git 状态（不做 commit/push/branch 等）。
 * 失败时返回 isRepo: false 或空数组，不抛错（git 不是 repo 是常见情况）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { Commit, FileChange, GitStatus } from '@shared/ipc/git'
import simpleGit, { type FileStatusResult } from 'simple-git'

import { logger } from './logger'

const log = logger.domain('git-service')

export async function getGitStatus(workspacePath: string): Promise<GitStatus> {
  // 检查是否 git repo
  const gitDir = join(workspacePath, '.git')
  if (!existsSync(gitDir)) {
    return {
      isRepo: false,
      branch: null,
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: [],
      untracked: [],
      recentCommits: [],
    }
  }

  try {
    const git = simpleGit(workspacePath)
    const status = await git.status()
    const recentCommits = await getRecentCommits(git, 20)

    const staged: FileChange[] = []
    const unstaged: FileChange[] = []
    const untracked: string[] = [...status.not_added]

    // status.files 包含所有变更
    for (const file of status.files) {
      const change = parseFileStatus(file)
      if (file.index !== ' ' && file.index !== '?') {
        // staged
        staged.push(change)
      }
      if (file.working_dir !== ' ' && file.working_dir !== '?') {
        // unstaged
        unstaged.push(change)
      }
      if (file.index === '?' || file.working_dir === '?') {
        if (!untracked.includes(file.path)) {
          untracked.push(file.path)
        }
      }
    }

    return {
      isRepo: true,
      branch: status.current,
      ahead: status.ahead,
      behind: status.behind,
      staged,
      unstaged,
      untracked,
      recentCommits,
    }
  } catch (e) {
    log.warn('git status failed:', e)
    return {
      isRepo: false,
      branch: null,
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: [],
      untracked: [],
      recentCommits: [],
    }
  }
}

function parseFileStatus(file: FileStatusResult): FileChange {
  const code = file.index !== ' ' ? file.index : file.working_dir
  let status: FileChange['status']
  switch (code) {
    case 'M':
      status = 'modified'
      break
    case 'A':
      status = 'added'
      break
    case 'D':
      status = 'deleted'
      break
    case 'R':
      status = 'renamed'
      break
    case 'C':
      status = 'renamed' // copy 当 rename
      break
    default:
      status = 'unknown'
  }
  return {
    path: file.path,
    status,
    staged: file.index !== ' ',
  }
}

async function getRecentCommits(
  git: ReturnType<typeof simpleGit>,
  limit: number,
): Promise<Commit[]> {
  try {
    const result = await git.log({ maxCount: limit })
    return result.all.map((c) => ({
      hash: c.hash,
      shortHash: c.hash.slice(0, 7),
      author: c.author_name,
      date: c.date,
      message: c.message,
    }))
  } catch {
    return []
  }
}
