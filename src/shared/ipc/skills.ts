/**
 * skills domain IPC 契约（Unified Skill Center）。
 * 函数签名即契约——main 实现，renderer 通过 window.api.skills 调用。
 *
 * **所有入口只接受 `id`（`<scope>:<name>`），不接受路径。** 路径一律由 main 从扫描
 * 结果里查出来。这跟 backend config files 是同一条安全边界：renderer 传不进来一个
 * 任意路径，否则 `skills.remove` 就等价于一个任意文件删除通道。
 *
 * 所有会改动磁盘的调用都回一份新的 snapshot，省掉调用方的第二次往返，也避免
 * "改完了但列表还是旧的"这种界面撒谎。
 */
import type { EditorId } from '../constants'
import type { SkillsSnapshot } from '../skills/types'

export interface SkillsScopeArgs {
  /** 当前工作区；给了才扫项目级技能（多根工作区会把每个文件夹都扫一遍）。 */
  workspaceId?: string
}

export interface SkillTargetArgs extends SkillsScopeArgs {
  /** `<scope>:<name>`，来自 SkillEntry.id */
  id: string
}

export interface SkillActionResult {
  ok: boolean
  /** 失败原因，直接显示给用户（例如 `~/.agents` 是 root 所有导致的 EACCES）。 */
  message?: string
  snapshot: SkillsSnapshot
}

export async function listSkills(_args: SkillsScopeArgs): Promise<SkillsSnapshot> {
  throw new Error('implemented in main')
}

export async function setSkillEnabled(
  _args: SkillTargetArgs & { enabled: boolean },
): Promise<SkillActionResult> {
  throw new Error('implemented in main')
}

/** 给统一目录里的技能补上另一个后端看得到的软链（修复"只有 codex 看得到"）。 */
export async function mirrorSkill(_args: SkillTargetArgs): Promise<SkillActionResult> {
  throw new Error('implemented in main')
}

/** 把后端自己目录里的真技能搬进统一目录，原地留一条软链。 */
export async function migrateSkill(_args: SkillTargetArgs): Promise<SkillActionResult> {
  throw new Error('implemented in main')
}

/** 只允许删项目级、且目录确实在当前工作区内的技能。 */
export async function removeSkill(_args: SkillTargetArgs): Promise<SkillActionResult> {
  throw new Error('implemented in main')
}

export async function revealSkill(_args: SkillTargetArgs): Promise<void> {
  throw new Error('implemented in main')
}

export async function openSkillInEditor(
  _args: SkillTargetArgs,
): Promise<{ launched: boolean; editor: EditorId | null; error?: string }> {
  throw new Error('implemented in main')
}

/**
 * 后端说「技能集合变了」。
 *
 * 空 payload——codex 的 `skills/changed` 本身就是个不带数据的失效信号，renderer
 * 收到后自己重扫（catmax 的快照一直来自 main 扫盘，不来自后端）。
 *
 * ⚠️ 这**不是**一个可靠的变更源，不要把它当成唯一的刷新机制。实测 codex 0.145
 * 只在 `skills/extraRoots/set` 之后推它：既不 watch 文件系统（往技能目录里新建一个
 * 技能等 6 秒没有任何通知），`skills/config/write` 之后也不推。真正兜底的是
 * renderer 侧的重扫时机（打开 popover、窗口重新聚焦、切工作区）。
 */
export type SkillsPushEvents = {
  'skills:changed': Record<string, never>
}

export type SkillsHandlers = {
  'skills.list': typeof listSkills
  'skills.setEnabled': typeof setSkillEnabled
  'skills.mirror': typeof mirrorSkill
  'skills.migrate': typeof migrateSkill
  'skills.remove': typeof removeSkill
  'skills.reveal': typeof revealSkill
  'skills.openInEditor': typeof openSkillInEditor
}
