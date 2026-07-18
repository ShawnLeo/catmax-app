/**
 * 解析 claude CLI 路径。和 codex-resolver 结构相同。
 */
import { existsSync } from 'node:fs'

import { logger } from './logger'

const log = logger.domain('claude-resolver')

export async function resolveClaudePath(customPath?: string | null): Promise<string | null> {
  if (customPath && existsSync(customPath)) {
    log.info('using custom path:', customPath)
    return customPath
  }

  try {
    const { execSync } = await import('node:child_process')
    const path = execSync('which claude', { encoding: 'utf-8', timeout: 3000 }).trim()
    if (path && existsSync(path)) {
      log.info('found in PATH:', path)
      return path
    }
  } catch {
    // not in PATH
  }

  log.warn('claude not found')
  return null
}
