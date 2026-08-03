/**
 * Unified Skill Center: 把统一目录里的技能软链到各后端自己的技能目录。
 *
 * 为什么是软链而不是给 claude 配一个 local plugin：plugin 那条路实测**能读到**外部
 * 目录，而且完全不碰用户的 `~/.claude/skills`，本来更干净——但它会把技能名变成
 * `plugin:skill`，而**带命名空间的技能关不掉**（`skillOverrides` 用全名、用裸名、
 * 换 `user-invocable-only` 三种都试过，命令表纹丝不动）。关技能是硬需求，所以软链。
 *
 * 这个模块的每一条规则都是为了同一件事：**绝不删用户的真技能**。
 * catmax 只认自己建的那些链（记在 userData/skill-mirror.json），清理时只动清单里的；
 * 遇到真目录、遇到别人建的软链，一律绕开并如实上报，不"顺手修复"。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import { app } from 'electron'

import { logger } from './logger'

const log = logger.domain('skill-mirror')

const MANIFEST_NAME = 'skill-mirror.json'

interface MirrorRecord {
  /** 软链本身的绝对路径，例如 ~/.claude/skills/lark-base */
  link: string
  /** 它该指向的技能目录绝对路径 */
  target: string
  createdAt: number
}

interface MirrorManifest {
  links: MirrorRecord[]
}

const EMPTY: MirrorManifest = { links: [] }

function manifestPath(): string {
  try {
    return join(app.getPath('userData'), MANIFEST_NAME)
  } catch {
    // 测试环境没有 electron app——退到主目录下的 catmax 私有目录，语义不变。
    return join(process.env.HOME ?? process.cwd(), '.catmax', MANIFEST_NAME)
  }
}

/** 同步读一次——扫描要用它算 `managed`，异步会把整条扫描链染成 async。 */
export function readMirrorManifest(): MirrorManifest {
  const path = manifestPath()
  if (!existsSync(path)) return EMPTY
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MirrorManifest>
    if (!Array.isArray(parsed.links)) return EMPTY
    return { links: parsed.links.filter((r) => typeof r?.link === 'string') }
  } catch (error) {
    // 清单读坏了只意味着"没有 catmax 管的链"，退化到最保守的行为（什么都不删）。
    log.warn('mirror manifest unreadable, treating as empty', error)
    return EMPTY
  }
}

async function writeMirrorManifest(manifest: MirrorManifest): Promise<void> {
  const path = manifestPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/** 这条软链是不是 catmax 建的。删除/覆盖前的唯一依据。 */
export function isManagedLink(linkPath: string, manifest = readMirrorManifest()): boolean {
  return manifest.links.some((r) => r.link === linkPath)
}

export type MirrorFailure =
  | 'occupied-by-directory'
  | 'occupied-by-foreign-link'
  | 'source-missing'
  | 'permission-denied'
  | 'unknown'

export interface MirrorResult {
  ok: boolean
  link: string
  reason?: MirrorFailure
  message?: string
}

/**
 * 软链的目标写相对路径还是绝对路径。
 *
 * POSIX 用相对（`../../.agents/skills/foo`）：跟机器上已有的那批 lark-* 链同一形态，
 * 主目录整体搬走也不断。Windows 只能用 junction——它**要求绝对路径**，而 junction
 * 恰好是唯一不需要管理员权限或开发者模式就能建目录链接的方式。
 */
function linkSpec(target: string, link: string): { target: string; type: 'dir' | 'junction' } {
  if (process.platform === 'win32') return { target: resolve(target), type: 'junction' }
  return { target: relative(dirname(link), target), type: 'dir' }
}

export async function createMirror(targetDir: string, linkPath: string): Promise<MirrorResult> {
  if (!existsSync(targetDir)) {
    return {
      ok: false,
      link: linkPath,
      reason: 'source-missing',
      message: `源目录不存在：${targetDir}`,
    }
  }

  const manifest = readMirrorManifest()
  let existing: ReturnType<typeof lstatSync> | null = null
  try {
    existing = lstatSync(linkPath)
  } catch {
    existing = null
  }

  if (existing) {
    if (!existing.isSymbolicLink()) {
      // 用户自己的真技能目录。绝不覆盖——那等于删掉他的文件。
      return {
        ok: false,
        link: linkPath,
        reason: 'occupied-by-directory',
        message: `${linkPath} 已经是一个真实目录（另一份独立副本），不会覆盖它`,
      }
    }
    const pointsHere = safeRealpath(linkPath) === safeRealpath(targetDir)
    if (pointsHere) {
      // 已经通了。可能是用户/安装器建的（本机那批 lark-*），接管但不重建。
      if (!isManagedLink(linkPath, manifest)) await remember(manifest, linkPath, targetDir)
      return { ok: true, link: linkPath }
    }
    if (!isManagedLink(linkPath, manifest)) {
      return {
        ok: false,
        link: linkPath,
        reason: 'occupied-by-foreign-link',
        message: `${linkPath} 是一条指向别处的软链，不是 catmax 建的，不会改动它`,
      }
    }
    await unlink(linkPath)
  }

  const spec = linkSpec(targetDir, linkPath)
  try {
    mkdirSync(dirname(linkPath), { recursive: true })
    await symlink(spec.target, linkPath, spec.type)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const reason: MirrorFailure =
      code === 'EACCES' || code === 'EPERM' ? 'permission-denied' : 'unknown'
    log.warn('mirror creation failed', { linkPath, targetDir, code })
    return { ok: false, link: linkPath, reason, message: String(error) }
  }

  await remember(manifest, linkPath, targetDir)
  log.info('mirror created', { linkPath, targetDir })
  return { ok: true, link: linkPath }
}

async function remember(
  manifest: MirrorManifest,
  linkPath: string,
  targetDir: string,
): Promise<void> {
  const links = manifest.links.filter((r) => r.link !== linkPath)
  links.push({ link: linkPath, target: targetDir, createdAt: Date.now() })
  await writeMirrorManifest({ links })
}

/**
 * 删掉一条 catmax 建的软链。
 *
 * 三道闸，缺一不可：清单里有 → 磁盘上确实是软链 → 才 unlink。少任何一道，
 * 一次路径算错就会变成删用户的技能目录。
 */
export async function removeMirror(linkPath: string): Promise<boolean> {
  const manifest = readMirrorManifest()
  if (!isManagedLink(linkPath, manifest)) return false
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) return false
    await unlink(linkPath)
  } catch {
    // 已经不在了也算成功——目标状态达成，清单该跟着清掉。
  }
  await writeMirrorManifest({ links: manifest.links.filter((r) => r.link !== linkPath) })
  return true
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * 项目级软链要让 git 装作看不见。
 *
 * 写 `.git/info/exclude` 而不是 `.gitignore`：前者是 per-clone 的、永远不进版本库，
 * 后者是用户仓库里的**受版本控制的文件**——catmax 不该往里塞自己的东西，那会出现在
 * 用户的下一次 diff 里。
 */
export async function excludeFromGit(folderPath: string, pattern: string): Promise<void> {
  const infoDir = join(folderPath, '.git', 'info')
  if (!existsSync(join(folderPath, '.git'))) return
  const file = join(infoDir, 'exclude')
  let current = ''
  try {
    current = await readFile(file, 'utf8')
  } catch {
    current = ''
  }
  if (current.split(/\r?\n/).some((line) => line.trim() === pattern)) return
  await mkdir(infoDir, { recursive: true })
  const prefix = current === '' || current.endsWith('\n') ? '' : '\n'
  await writeFile(file, `${current}${prefix}${pattern}\n`, 'utf8')
  log.info('added to .git/info/exclude', { folderPath, pattern })
}
