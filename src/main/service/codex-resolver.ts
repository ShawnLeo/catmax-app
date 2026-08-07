/**
 * 解析 codex CLI 路径——settings 里没有手动配置时的自动发现兜底。
 *
 * 背景：Electron GUI app 启动时的 PATH 已经被 `fix-path`（见 src/main/index.ts）
 * 用登录 shell 的完整 PATH 修过一次，但仍有两类用户会漏检：
 * 1. 装在不出现在任何 shell rc 里的固定目录（Homebrew、npm 全局 prefix、nvm 版本目录……），
 *    或者登录 shell 的 rc 没有正确导出 PATH（比如 nvm 只在 .bashrc 里挂钩，但登录 shell 是 zsh）。
 * 2. app 运行期间才装的 codex——fix-path 只在启动时跑一次，不会重新探测。
 *
 * 优先级：
 * 1. 调用方传入的自定义路径（settings.backendPaths.codex）
 * 2. PATH 中的 codex（which/where）——多数用户已经能靠 fix-path 命中，这里再兜一次
 * 3. catmax 自己一键安装写入的目录（userData/backends/codex/<version>/bin/codex）——
 *    覆盖"以前装过，但 settings.json 被重置/换过 profile"的场景
 * 4. npm 全局 bin 目录（`npm prefix -g` 拼出来，不猜 vendor 内部结构）
 * 5. 常见固定安装目录（Homebrew / ~/.local/bin / ~/.npm-global/bin / ~/.volta/bin 等）
 * 6. nvm 各 node 版本目录下的全局 bin（每个 nvm 版本都有独立的全局 bin）
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { app } from 'electron'

import { logger } from './logger'

const log = logger.domain('codex-resolver')

const CODEX_BIN = process.platform === 'win32' ? 'codex.exe' : 'codex'

/** 找 codex 可执行文件路径。找不到返回 null。 */
export async function resolveCodexPath(customPath?: string | null): Promise<string | null> {
  // 1. 用户自定义
  if (customPath && existsSync(customPath)) {
    log.info('using custom path:', customPath)
    return customPath
  }

  const resolvers: Array<() => string | null | Promise<string | null>> = [
    tryWhich,
    tryManagedInstall,
    tryNpmGlobalBin,
    tryCommonLocations,
    tryNvmVersions,
  ]

  for (const resolve of resolvers) {
    const found = await resolve()
    if (found) {
      log.info('resolved codex at:', found)
      return found
    }
  }

  log.warn('codex not found in PATH or any known install location')
  return null
}

/** PATH 中查找——理论上 fix-path 已经把 PATH 修好，这里是兜底而非主力 */
async function tryWhich(): Promise<string | null> {
  try {
    const { execSync } = await import('node:child_process')
    const cmd = process.platform === 'win32' ? 'where codex' : 'which codex'
    const out = execSync(cmd, { encoding: 'utf-8', timeout: 3000 })
    const path = out.split(/\r?\n/)[0]?.trim()
    return path && existsSync(path) ? path : null
  } catch {
    return null
  }
}

/** catmax 一键安装落地的目录——按版本号倒序找最新可用的一份 */
function tryManagedInstall(): string | null {
  try {
    const root = join(app.getPath('userData'), 'backends', 'codex')
    if (!existsSync(root)) return null
    const versions = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort(compareVersionsDesc)
    for (const version of versions) {
      const candidate = join(root, version, 'bin', CODEX_BIN)
      if (existsSync(candidate)) return candidate
    }
  } catch (e) {
    log.warn('tryManagedInstall failed:', e)
  }
  return null
}

/**
 * `npm prefix -g` 拼出全局 bin 目录——不假设 @openai/codex 包内部的 vendor 布局，
 * 只依赖 npm 自己"全局包的可执行文件放在 prefix/bin（Windows 上直接放 prefix 下）"这个稳定约定。
 */
async function tryNpmGlobalBin(): Promise<string | null> {
  try {
    const { execSync } = await import('node:child_process')
    const prefix = execSync('npm prefix -g', { encoding: 'utf-8', timeout: 3000 }).trim()
    if (!prefix) return null
    const candidate =
      process.platform === 'win32' ? join(prefix, 'codex.cmd') : join(prefix, 'bin', 'codex')
    return existsSync(candidate) ? candidate : null
  } catch {
    return null
  }
}

/** 常见固定安装位置——Homebrew / 用户级 bin 目录，多数不在精简版 PATH 里 */
function tryCommonLocations(): string | null {
  const home = homedir()
  const candidates =
    process.platform === 'win32'
      ? [
          join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm', 'codex.cmd'),
          join(home, 'AppData', 'Local', 'Volta', 'bin', 'codex.exe'),
        ]
      : [
          '/opt/homebrew/bin/codex',
          '/usr/local/bin/codex',
          join(home, '.local', 'bin', 'codex'),
          join(home, '.npm-global', 'bin', 'codex'),
          join(home, '.volta', 'bin', 'codex'),
        ]
  return candidates.find((p) => existsSync(p)) ?? null
}

/** nvm 每个 node 版本都有独立的全局 bin 目录，按版本号倒序找最新可用的一份 */
function tryNvmVersions(): string | null {
  if (process.platform === 'win32') return null
  try {
    const nvmDir = join(homedir(), '.nvm', 'versions', 'node')
    if (!existsSync(nvmDir)) return null
    const versions = readdirSync(nvmDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(compareVersionsDesc)
    for (const version of versions) {
      const candidate = join(nvmDir, version, 'bin', 'codex')
      if (existsSync(candidate)) return candidate
    }
  } catch (e) {
    log.warn('tryNvmVersions failed:', e)
  }
  return null
}

/** 简单版本号倒序比较——形如 "0.146.0" / "v20.11.0"，非数字部分按字符串比较兜底 */
function compareVersionsDesc(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0
    const nb = pb[i] ?? 0
    if (Number.isNaN(na) || Number.isNaN(nb)) break
    if (na !== nb) return nb - na
  }
  return b.localeCompare(a)
}
