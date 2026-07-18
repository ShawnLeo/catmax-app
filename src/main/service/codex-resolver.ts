/**
 * 解析 codex CLI 路径。
 *
 * 优先级：
 * 1. settings.json 的 backendPaths.codex（用户自定义）
 * 2. PATH 中的 codex
 * 3. 全局 npm 安装路径（fallback）
 */
import { existsSync } from 'node:fs'

import { logger } from './logger'

const log = logger.domain('codex-resolver')

/** 找 codex 可执行文件路径。找不到返回 null。 */
export async function resolveCodexPath(customPath?: string | null): Promise<string | null> {
  // 1. 用户自定义
  if (customPath && existsSync(customPath)) {
    log.info('using custom path:', customPath)
    return customPath
  }

  // 2. which codex
  try {
    const { execSync } = await import('node:child_process')
    const path = execSync('which codex', { encoding: 'utf-8', timeout: 3000 }).trim()
    if (path && existsSync(path)) {
      log.info('found in PATH:', path)
      return path
    }
  } catch {
    // which 失败，继续 fallback
  }

  // 3. 全局 npm 路径（pnpm/npm 全局装的位置）
  try {
    const { execSync } = await import('node:child_process')
    const globalRoot = execSync('npm root -g', { encoding: 'utf-8', timeout: 3000 }).trim()
    const candidate = `${globalRoot}/@openai/codex/vendor/aarch64-apple-darwin/codex/codex`
    if (existsSync(candidate)) {
      log.info('found via npm global:', candidate)
      return candidate
    }
  } catch {
    // 失败
  }

  log.warn('codex not found')
  return null
}
