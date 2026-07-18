import type { GitHandlers } from '@shared/ipc/git'

import { handleRendererRequest } from '../../typed'

import { getGitStatusHandler } from './handlers'

export function registerGitHandlers(): void {
  handleRendererRequest<GitHandlers, 'git.status'>('git.status', getGitStatusHandler)
}

export type { GitHandlers } from '@shared/ipc/git'
