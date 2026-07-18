import { getGitStatus } from '@main/service/git-service'
import type { GitStatus } from '@shared/ipc/git'

export const getGitStatusHandler = async (args: { workspacePath: string }): Promise<GitStatus> => {
  return getGitStatus(args.workspacePath)
}
