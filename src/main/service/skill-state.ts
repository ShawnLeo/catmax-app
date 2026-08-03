/**
 * Unified Skill Center: 「哪些技能被用户关掉了」这一份状态，catmax 自己拥有。
 *
 * **按技能名存，不按路径。** 看起来路径更精确（同名技能可能来自不同根目录），但
 * claude 那边的开关只有 `settings.skillOverrides`，它是**纯按名字**索引的，没有
 * 路径选择器。既然一半的投影只能按名字，就不该在另一半假装能按路径——那会造出
 * 一个 catmax 自以为做到、实际做不到的语义。
 *
 * 代价要说清楚：一个全局技能和一个项目技能同名时，两者只能一起开关。这在后端
 * 那边本来也是同一个名字空间，分不开。
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { app } from 'electron'

import { logger } from './logger'

const log = logger.domain('skill-state')

const STATE_NAME = 'skills-state.json'

interface SkillsState {
  /** 被关掉的技能名 */
  disabled: string[]
}

function statePath(): string {
  try {
    return join(app.getPath('userData'), STATE_NAME)
  } catch {
    return join(process.env.HOME ?? process.cwd(), '.catmax', STATE_NAME)
  }
}

export function readDisabledSkills(): Set<string> {
  const path = statePath()
  if (!existsSync(path)) return new Set()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SkillsState>
    if (!Array.isArray(parsed.disabled)) return new Set()
    return new Set(parsed.disabled.filter((n): n is string => typeof n === 'string'))
  } catch (error) {
    // 状态文件坏了就当"全部启用"——比让技能列表整个打不开好。
    log.warn('skills state unreadable, treating all as enabled', error)
    return new Set()
  }
}

export async function writeDisabledSkills(disabled: Set<string>): Promise<void> {
  const path = statePath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ disabled: [...disabled].sort() }, null, 2)}\n`, 'utf8')
}

/**
 * claude 侧的投影：禁用集合 → `settings.skillOverrides`。
 *
 * 全部启用时返回 null 而不是空对象，让调用方能走"完全不合并"那条路径
 * （见 ClaudeAdapter.applyOverrideSettings）。
 *
 * 取值用 `'off'`——它同时对模型和用户隐藏。另外两档没用上但值得记着：
 * `'name-only'` 只列名字不列描述（省 context 的中间档），
 * `'user-invocable-only'` 模型看不见但 `/name` 还能打。
 */
export function disabledSkillOverrides(): Record<string, 'off'> | null {
  const disabled = readDisabledSkills()
  if (disabled.size === 0) return null
  return Object.fromEntries([...disabled].map((name) => [name, 'off' as const]))
}

/**
 * 把 catmax 算出来的 skillOverrides 合进用户自己的覆盖配置。
 *
 * **用户写的优先。** 他在覆盖文件里显式写了某个技能的档位（比如 `name-only`），
 * 那是明确表达过的意图，不该被 UI 上的一个开关悄悄盖掉；反过来 catmax 的开关
 * 只负责补上用户没表过态的那些。
 */
export function mergeSkillOverrides(
  base: Record<string, unknown>,
  computed: Record<string, 'off'>,
): Record<string, unknown> {
  const existing =
    typeof base.skillOverrides === 'object' && base.skillOverrides !== null
      ? (base.skillOverrides as Record<string, unknown>)
      : {}
  return { ...base, skillOverrides: { ...computed, ...existing } }
}

/** 返回写入后的完整禁用集合，调用方拿它去投影到两个后端。 */
export async function setSkillEnabled(name: string, enabled: boolean): Promise<Set<string>> {
  const disabled = readDisabledSkills()
  if (enabled) disabled.delete(name)
  else disabled.add(name)
  await writeDisabledSkills(disabled)
  return disabled
}
