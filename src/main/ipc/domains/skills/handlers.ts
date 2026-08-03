/**
 * Unified Skill Center 的 IPC 实现。
 *
 * 安全边界：renderer 只传 `id`（`<scope>:<name>`），所有路径都在这里从扫描结果里
 * 查出来。它跟 backend config files 是同一条原则——如果 renderer 能传路径进来，
 * `skills.remove` 就等价于一个任意文件删除通道。
 */
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { ctx } from '@main/context'
import { launchInEditor } from '@main/service/editor-launcher'
import { logger } from '@main/service/logger'
import {
  createMirror,
  excludeFromGit,
  removeMirror,
  type MirrorResult,
} from '@main/service/skill-mirror'
import { backendRoot, unifiedGlobalRoot, unifiedProjectRoot } from '@main/service/skill-roots'
import { isInsideFolder, scanSkills } from '@main/service/skill-scanner'
import {
  readDisabledSkills,
  setSkillEnabled as persistSkillEnabled,
} from '@main/service/skill-state'
import { DEFAULT_EDITOR } from '@shared/constants'
import type { EditorId } from '@shared/constants'
import type { SkillActionResult, SkillTargetArgs, SkillsScopeArgs } from '@shared/ipc/skills'
import type { SkillEntry, SkillsSnapshot } from '@shared/skills/types'
import { shell } from 'electron'

const log = logger.domain('skills-handler')

/** 当前工作区的所有文件夹（多根工作区每个都算项目级技能的来源）。 */
function folderPathsOf(workspaceId: string | undefined): string[] {
  if (!workspaceId) return []
  const workspace = ctx.db.findWorkspaceById(workspaceId)
  if (!workspace) return []
  return workspace.folders.map((f) => f.path)
}

function snapshotFor(args: SkillsScopeArgs): SkillsSnapshot {
  return scanSkills({ folderPaths: folderPathsOf(args.workspaceId) })
}

function findEntry(snapshot: SkillsSnapshot, id: string): SkillEntry | null {
  return snapshot.entries.find((e) => e.id === id) ?? null
}

function fail(snapshot: SkillsSnapshot, message: string): SkillActionResult {
  return { ok: false, message, snapshot }
}

/**
 * 改完盘之后重扫，并让后端也丢掉技能缓存。
 *
 * 所有改盘的 handler 都必须走这里拿 snapshot，而不是直接 `snapshotFor`：codex 把技能
 * 列表缓存在 app-server 进程里且不 watch 文件系统，少叫它一次，catmax 的列表就会
 * 领先于 codex 实际看得到的东西——界面显示成功、下一轮对话里技能却不存在。
 */
async function snapshotAfterWrite(args: SkillsScopeArgs): Promise<SkillsSnapshot> {
  await ctx.backendManager.refreshSkills()
  return snapshotFor(args)
}

export const listSkills = async (args: SkillsScopeArgs): Promise<SkillsSnapshot> => {
  return snapshotFor(args)
}

export const setSkillEnabled = async (
  args: SkillTargetArgs & { enabled: boolean },
): Promise<SkillActionResult> => {
  const before = snapshotFor(args)
  const entry = findEntry(before, args.id)
  if (!entry) return fail(before, `找不到技能：${args.id}`)

  await persistSkillEnabled(entry.name, args.enabled)
  const { failed } = await ctx.backendManager.setSkillEnabled(entry.name, args.enabled)

  const snapshot = snapshotFor(args)
  if (failed.length > 0) {
    // catmax 自己的状态已经落盘，claude 下一轮就生效；这里只是 codex 没推上。
    // 报成"部分成功"而不是失败——回滚会让 claude 那边也跟着白改。
    return {
      ok: true,
      message: `已保存，但 ${failed.join('/')} 未能同步（后端可能没启动，下次启动会补上）`,
      snapshot,
    }
  }
  return { ok: true, snapshot }
}

/** 某个 kind 的根目录（全局取主目录，项目取技能所属的工作区文件夹）。 */
function rootFor(entry: SkillEntry, kind: 'agents' | 'codex' | 'claude'): string | null {
  if (entry.scope === 'global') return backendRoot(kind, homedir())
  if (!entry.folderPath) return null
  return backendRoot(kind, entry.folderPath)
}

export const mirrorSkill = async (args: SkillTargetArgs): Promise<SkillActionResult> => {
  const before = snapshotFor(args)
  const entry = findEntry(before, args.id)
  if (!entry) return fail(before, `找不到技能：${args.id}`)

  const source = entry.locations.find((l) => l.kind === 'agents' && !l.symlink)
  if (!source) {
    // 只镜像统一目录里的真目录。副本 → 副本的软链只会让漂移更难看清，
    // 那种情况该走 migrate（先搬进统一目录）。
    return fail(before, '这个技能还不在统一目录里，请先「迁移到统一目录」')
  }

  const results: MirrorResult[] = []
  for (const kind of ['codex', 'claude'] as const) {
    if (entry.locations.some((l) => l.kind === kind)) continue
    const root = rootFor(entry, kind)
    if (!root) continue
    results.push(await createMirror(source.dir, join(root, basename(source.dir))))
  }

  if (entry.scope === 'project' && entry.folderPath) {
    // 项目级软链要让 git 装作看不见——写 .git/info/exclude（per-clone，不进版本库），
    // 不写 .gitignore（那是用户仓库里受版本控制的文件）。
    await excludeFromGit(entry.folderPath, '.codex/skills/')
    await excludeFromGit(entry.folderPath, '.claude/skills/')
  }

  const snapshot = await snapshotAfterWrite(args)
  const failures = results.filter((r) => !r.ok)
  if (failures.length > 0) {
    return { ok: false, message: failures.map((f) => f.message).join('；'), snapshot }
  }
  return { ok: true, snapshot }
}

export const migrateSkill = async (args: SkillTargetArgs): Promise<SkillActionResult> => {
  const before = snapshotFor(args)
  const entry = findEntry(before, args.id)
  if (!entry) return fail(before, `找不到技能：${args.id}`)
  if (entry.unified) return fail(before, '这个技能已经在统一目录里了')

  // 只搬真目录。软链本来就指向别处，"搬"它没有意义。
  const source = entry.locations.find((l) => !l.symlink)
  if (!source) return fail(before, '没有可迁移的真实目录（全部都是软链）')

  const targetRoot =
    entry.scope === 'global'
      ? unifiedGlobalRoot()
      : entry.folderPath
        ? unifiedProjectRoot(entry.folderPath)
        : null
  if (!targetRoot) return fail(before, '无法确定统一目录位置')

  const target = join(targetRoot, basename(source.dir))
  try {
    const { mkdir, rename } = await import('node:fs/promises')
    await mkdir(targetRoot, { recursive: true })
    // rename 而不是 copy+delete：同一文件系统内是原子的，中途失败不会留下半份技能。
    await rename(source.dir, target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const hint =
      code === 'EACCES' || code === 'EPERM'
        ? `没有写入权限：${targetRoot}（这个目录可能不属于当前用户）`
        : code === 'EXDEV'
          ? '源目录和统一目录不在同一个文件系统上，无法原子迁移'
          : String(error)
    return fail(before, hint)
  }

  // 原地留一条软链，让原来看得到它的后端继续看得到。
  const linkBack = await createMirror(target, source.dir)
  if (entry.scope === 'project' && entry.folderPath) {
    // 项目级迁移同样会在 .codex/.claude 下留下受管软链；与 mirror 保持一致，
    // 将这两个目录写入 per-clone exclude，避免迁移后立刻污染 git status。
    await excludeFromGit(entry.folderPath, '.codex/skills/')
    await excludeFromGit(entry.folderPath, '.claude/skills/')
  }
  const snapshot = await snapshotAfterWrite(args)
  if (!linkBack.ok) {
    return {
      ok: false,
      message: `已迁移到 ${target}，但原位置的软链没建成：${linkBack.message ?? ''}`,
      snapshot,
    }
  }
  log.info('skill migrated to unified root', { id: entry.id, target })
  return { ok: true, snapshot }
}

export const removeSkill = async (args: SkillTargetArgs): Promise<SkillActionResult> => {
  const before = snapshotFor(args)
  const entry = findEntry(before, args.id)
  if (!entry) return fail(before, `找不到技能：${args.id}`)

  // 只删项目级：全局技能可能被别的项目、别的工具依赖，删掉的影响远超当前窗口。
  if (entry.scope !== 'project' || !entry.folderPath) {
    return fail(before, '只支持删除当前项目的技能')
  }

  const folder = entry.folderPath
  for (const loc of entry.locations) {
    if (!isInsideFolder(loc.dir, folder)) {
      // 越界就整体拒绝，不做"删一半"。
      return fail(before, `拒绝删除工作区之外的路径：${loc.dir}`)
    }
  }

  for (const loc of entry.locations) {
    if (loc.symlink) {
      // 软链优先走 mirror 的三道闸；不是 catmax 建的就退回 rm（它仍在工作区内，
      // 且 rm 一条软链不会碰到它指向的内容）。
      if (await removeMirror(loc.dir)) continue
    }
    try {
      await rm(loc.dir, { recursive: true, force: true })
    } catch (error) {
      return fail(before, `删除失败：${loc.dir}（${String(error)}）`)
    }
  }

  log.info('project skill removed', { id: entry.id })
  return { ok: true, snapshot: await snapshotAfterWrite(args) }
}

export const revealSkill = async (args: SkillTargetArgs): Promise<void> => {
  const entry = findEntry(snapshotFor(args), args.id)
  if (!entry) return
  // showItemInFolder 的语义是"在父目录里选中这一项"，正是"在访达中显示"该有的效果。
  shell.showItemInFolder(entry.primary.path)
}

export const openSkillInEditor = async (
  args: SkillTargetArgs,
): Promise<{ launched: boolean; editor: EditorId | null; error?: string }> => {
  const entry = findEntry(snapshotFor(args), args.id)
  if (!entry) return { launched: false, editor: null, error: `找不到技能：${args.id}` }

  const workspace = args.workspaceId ? ctx.db.findWorkspaceById(args.workspaceId) : null
  const editor = workspace?.preferredEditor ?? DEFAULT_EDITOR
  // 技能大多在工作区之外（`~/.agents/skills`），所以只走 absolutePath 这条路。
  return launchInEditor(editor, {
    workspacePath: entry.primary.dir,
    relativePath: 'SKILL.md',
    absolutePath: entry.primary.path,
  })
}

/**
 * 启动时把禁用集合补推给后端。
 *
 * codex 那条投影是推送式的：应用没跑时用户在别处改了 `~/.codex/config.toml`，或者
 * 上次推送时 codex 没起来，两边就漂了。失败不阻塞启动——技能开关不该拖住主流程。
 */
export async function syncSkillsOnStartup(): Promise<void> {
  const disabled = readDisabledSkills()
  if (disabled.size === 0) return
  try {
    await ctx.backendManager.syncDisabledSkills(disabled)
  } catch (error) {
    log.warn('startup skill sync failed', error)
  }
}
