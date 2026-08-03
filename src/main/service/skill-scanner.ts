/**
 * Unified Skill Center: 扫盘，把散落在三个根目录里的技能合成一份统一视图。
 *
 * 纯文件系统操作，不依赖任何后端在跑——设置页要在 codex 没装、claude 没起的时候
 * 也能把列表显示出来。后端只在"投影开关状态"时才用得上（见 skill-projection.ts）。
 *
 * 合并键是**技能名**：镜像软链和统一目录里的真目录同名，独立副本也同名，正好都该
 * 归成一条。`locations[].symlink` 才是区分它们的依据。
 */
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'

import type { BackendId } from '@shared/constants'
import { parseSkillFrontmatter } from '@shared/skills/frontmatter'
import type {
  SkillEntry,
  SkillLocation,
  SkillScanIssue,
  SkillScope,
  SkillsSnapshot,
} from '@shared/skills/types'

import { logger } from './logger'
import { isManagedLink, readMirrorManifest } from './skill-mirror'
import {
  globalRoots,
  projectRoots,
  ROOT_ORDER,
  ROOT_VISIBILITY,
  unifiedGlobalRoot,
  type SkillRoot,
} from './skill-roots'
import { readDisabledSkills } from './skill-state'

const log = logger.domain('skill-scanner')

/** SKILL.md 再大也不该读进来——技能正文是给模型看的，这里只要 frontmatter。 */
const MAX_FRONTMATTER_BYTES = 64 * 1024

interface RawSkill {
  name: string
  description: string
  location: SkillLocation
  scope: SkillScope
  folderPath: string | null
}

function readHead(path: string): string {
  const raw = readFileSync(path, 'utf8')
  return raw.length > MAX_FRONTMATTER_BYTES ? raw.slice(0, MAX_FRONTMATTER_BYTES) : raw
}

/**
 * 扫一个根目录下的直接子目录。
 *
 * 只看一层：技能的约定是 `<root>/<name>/SKILL.md`，往下递归会把技能自己的
 * `references/` 也当成技能。以 `.` 开头的跳过——`~/.codex/skills/.system` 是
 * codex 的内置技能，不是用户放的东西。
 */
function scanRoot(
  root: SkillRoot,
  managed: (linkPath: string) => boolean,
  issues: SkillScanIssue[],
): RawSkill[] {
  if (!existsSync(root.path)) return []

  let names: string[]
  try {
    names = readdirSync(root.path)
  } catch (error) {
    issues.push({ path: root.path, message: `无法读取目录：${String(error)}` })
    return []
  }

  const out: RawSkill[] = []
  for (const entry of names) {
    if (entry.startsWith('.')) continue
    const dir = join(root.path, entry)
    const skillFile = join(dir, 'SKILL.md')
    try {
      // statSync 跟随软链——软链指向的目录也要算作目录。
      if (!statSync(dir).isDirectory()) continue
      if (!existsSync(skillFile)) continue

      const symlink = lstatSync(dir).isSymbolicLink()
      const front = parseSkillFrontmatter(readHead(skillFile))
      out.push({
        name: front.name?.trim() || entry,
        description: front.description ?? '',
        scope: root.scope,
        folderPath: root.folderPath,
        location: {
          kind: root.kind,
          path: skillFile,
          dir,
          symlink,
          realDir: safeRealpath(dir),
          managed: symlink && managed(dir),
        },
      })
    } catch (error) {
      issues.push({ path: dir, message: String(error) })
    }
  }
  return out
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

function mergeLocations(raws: RawSkill[]): SkillLocation[] {
  return [...raws]
    .sort((a, b) => ROOT_ORDER.indexOf(a.location.kind) - ROOT_ORDER.indexOf(b.location.kind))
    .map((r) => r.location)
}

function visibilityOf(locations: SkillLocation[]): BackendId[] {
  const seen = new Set<BackendId>()
  for (const loc of locations) for (const id of ROOT_VISIBILITY[loc.kind]) seen.add(id)
  return [...seen].sort()
}

function toEntry(head: RawSkill, raws: RawSkill[], disabled: Set<string>): SkillEntry {
  const locations = mergeLocations(raws)
  const { name, scope } = head
  // 描述取第一个非空的——副本之间可能漂移，显示哪个都不算错，空着才是错。
  const description = raws.map((r) => r.description).find((d) => d.trim() !== '') ?? ''
  return {
    id: `${scope}:${name}`,
    name,
    description,
    scope,
    folderPath: head.folderPath,
    locations,
    primary: locations[0] ?? head.location,
    unified: locations.some((l) => l.kind === 'agents'),
    visibleTo: visibilityOf(locations),
    enabled: !disabled.has(name),
  }
}

export interface ScanOptions {
  /** 当前工作区的所有文件夹（多根工作区每个都扫）。空数组 = 只扫全局。 */
  folderPaths?: string[]
}

export function scanSkills(options: ScanOptions = {}): SkillsSnapshot {
  const issues: SkillScanIssue[] = []
  const manifest = readMirrorManifest()
  const managed = (linkPath: string): boolean => isManagedLink(linkPath, manifest)
  const disabled = readDisabledSkills()

  const roots: SkillRoot[] = [
    ...globalRoots(),
    ...(options.folderPaths ?? []).flatMap((folder) => projectRoots(folder)),
  ]

  // 按 `scope:name` 分组——全局和项目同名是两条独立记录，不该合并显示。
  const grouped = new Map<string, RawSkill[]>()
  for (const root of roots) {
    for (const raw of scanRoot(root, managed, issues)) {
      const key = `${raw.scope}:${raw.name}`
      const bucket = grouped.get(key)
      if (bucket) bucket.push(raw)
      else grouped.set(key, [raw])
    }
  }

  const entries = [...grouped.values()]
    .flatMap((raws) => (raws[0] ? [toEntry(raws[0], raws, disabled)] : []))
    .sort((a, b) =>
      a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'global' ? -1 : 1,
    )

  const unifiedPath = unifiedGlobalRoot()
  const exists = existsSync(unifiedPath)
  if (issues.length > 0) log.info('scan finished with issues', issues.length)

  return {
    entries,
    issues,
    unifiedRoot: {
      path: unifiedPath,
      exists,
      // 目录不存在时看父目录能不能建——`~/.agents` 在有些机器上是 root 所有的，
      // 那种情况下软链和删除都会 EACCES，界面要提前说清楚而不是等操作失败。
      writable: exists ? isWritable(unifiedPath) : isWritable(join(unifiedPath, '..', '..')),
    },
  }
}

/** 用于「删除」的守卫：这个技能目录在不在给定的工作区文件夹里。 */
export function isInsideFolder(dir: string, folderPath: string): boolean {
  const target = safeRealpath(dir)
  const base = safeRealpath(folderPath)
  return target === base || target.startsWith(base.endsWith('/') ? base : `${base}/`)
}
