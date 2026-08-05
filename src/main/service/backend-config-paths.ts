/**
 * Backend Config Files: 两个配置根目录的解析。
 *
 * 单独成一个模块只有一个原因——`backend-config-files.ts`（读写文件）和
 * `claude-settings-profiles.ts`（管理 Claude 覆盖配置的多份档案）都要用它，
 * 而前者又要向后者问"当前档是哪个文件"。放在任一边都会形成循环 import。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { BackendId } from '@shared/constants'
import { app } from 'electron'

/**
 * 后端配置目录。两个后端都支持用环境变量改默认位置，这里跟随——
 * 否则用户明明把 codex 指到别处，设置页却在编辑一个 codex 根本不读的文件。
 */
export function resolveBackendConfigDir(backendId: BackendId): string {
  if (backendId === 'codex') {
    const override = process.env.CODEX_HOME?.trim()
    return override ? override : join(homedir(), '.codex')
  }
  if (backendId === 'claude') {
    const override = process.env.CLAUDE_CONFIG_DIR?.trim()
    return override ? override : join(homedir(), '.claude')
  }
  return join(homedir(), `.${backendId}`)
}

/**
 * catmax 自己拥有的后端覆盖配置目录。带非 Electron 回退，
 * 好让 vitest 里不 mock electron 也能跑。
 */
export function catmaxBackendConfigDir(): string {
  try {
    return join(app.getPath('userData'), 'backend-settings')
  } catch {
    return join(homedir(), '.catmax', 'backend-settings')
  }
}
