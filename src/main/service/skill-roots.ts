/**
 * Unified Skill Center: 两个后端各自扫哪些目录——全部经实测确认，不是照文档抄的。
 *
 * codex 0.145.0（`skills/list` 返回的 path 归并得到）：
 *   全局 `~/.agents/skills`、`~/.codex/skills`（含 `.system` 子目录，系统内置）
 *   仓库 `<repo>/.agents/skills`、`<repo>/.codex/skills`
 *   **不扫** `<repo>/.claude/skills`
 * claude（内置 2.1.220，`initializationResult().commands` 观测）：
 *   全局 `~/.claude/skills`、仓库 `<repo>/.claude/skills`
 *   二进制里 `.agents` 这个字符串**根本不存在**——这就是要建软链的原因。
 *
 * 不在这里列的两类技能故意不管：codex 的 plugin 技能（`~/.codex/plugins/cache/<plugin>/<ver>/skills`，
 * 名字带 `plugin:` 前缀，由 marketplace 管生命周期）和两边的内置技能。它们不是用户
 * 自己放的文件，catmax 去动它们只会跟包管理器打架。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { BackendId } from '@shared/constants'
import type { SkillRootKind, SkillScope } from '@shared/skills/types'

export interface SkillRoot {
  kind: SkillRootKind
  scope: SkillScope
  /** 根目录绝对路径（可能不存在） */
  path: string
  /** project scope 时是所属的工作区文件夹；global 为 null */
  folderPath: string | null
}

/** 每种根目录被哪些后端扫到。统一目录只有 codex 认——这正是不对称的来源。 */
export const ROOT_VISIBILITY: Record<SkillRootKind, BackendId[]> = {
  agents: ['codex'],
  codex: ['codex'],
  claude: ['claude'],
}

/** 统一目录的相对位置。全局是 `~/.agents/skills`，项目是 `<folder>/.agents/skills`。 */
export const UNIFIED_RELATIVE = join('.agents', 'skills')

const RELATIVE_BY_KIND: Record<SkillRootKind, string> = {
  agents: UNIFIED_RELATIVE,
  codex: join('.codex', 'skills'),
  claude: join('.claude', 'skills'),
}

/** 顺序即优先级：主位置优先取统一目录，其次 codex，最后 claude。 */
export const ROOT_ORDER: SkillRootKind[] = ['agents', 'codex', 'claude']

export function unifiedGlobalRoot(): string {
  return join(homedir(), UNIFIED_RELATIVE)
}

export function unifiedProjectRoot(folderPath: string): string {
  return join(folderPath, UNIFIED_RELATIVE)
}

/** 某个后端在 scope 下的目录（镜像软链就建在这里面）。 */
export function backendRoot(kind: SkillRootKind, base: string): string {
  return join(base, RELATIVE_BY_KIND[kind])
}

export function globalRoots(): SkillRoot[] {
  const home = homedir()
  return ROOT_ORDER.map((kind) => ({
    kind,
    scope: 'global' as const,
    path: backendRoot(kind, home),
    folderPath: null,
  }))
}

export function projectRoots(folderPath: string): SkillRoot[] {
  return ROOT_ORDER.map((kind) => ({
    kind,
    scope: 'project' as const,
    path: backendRoot(kind, folderPath),
    folderPath,
  }))
}
