// @vitest-environment node
/**
 * Unified Skill Center 的扫描 / 软链 / 状态三件事。
 *
 * 全部在临时 HOME 下跑：`globalRoots()` 走 `os.homedir()`，而 POSIX 下它读的就是
 * `$HOME`。不改 HOME 的话这个测试会去翻用户真实的 `~/.agents/skills`，既不可重现
 * 也可能真的动到人家的技能。
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.userDataDir } }))

const { createMirror, excludeFromGit, isManagedLink, removeMirror } =
  await import('@main/service/skill-mirror')
const { scanSkills, isInsideFolder } = await import('@main/service/skill-scanner')
const { readDisabledSkills, setSkillEnabled, disabledSkillOverrides, mergeSkillOverrides } =
  await import('@main/service/skill-state')

let home = ''
let repo = ''
let originalHome: string | undefined

function writeSkill(root: string, name: string, description = `${name} 的说明`): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n正文\n`,
  )
  return dir
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'catmax-skills-'))
  home = join(base, 'home')
  repo = join(base, 'repo')
  mocks.userDataDir = join(base, 'userData')
  mkdirSync(home, { recursive: true })
  mkdirSync(repo, { recursive: true })
  mkdirSync(mocks.userDataDir, { recursive: true })
  originalHome = process.env.HOME
  process.env.HOME = home
})

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  rmSync(join(home, '..'), { recursive: true, force: true })
})

describe('scanSkills', () => {
  test('统一目录里的技能只有 codex 看得到——claude 不认识 .agents', () => {
    // 这条是整个功能的前提：实测 claude 二进制里连 `.agents` 这个字符串都没有。
    writeSkill(join(home, '.agents', 'skills'), 'alpha')

    const entry = scanSkills().entries.find((e) => e.name === 'alpha')
    expect(entry).toBeDefined()
    expect(entry!.visibleTo).toEqual(['codex'])
    expect(entry!.unified).toBe(true)
  })

  test('三个根目录里的同名技能合成一条，locations 摊开', () => {
    writeSkill(join(home, '.agents', 'skills'), 'beta')
    writeSkill(join(home, '.codex', 'skills'), 'beta')
    writeSkill(join(home, '.claude', 'skills'), 'beta')

    const entry = scanSkills().entries.find((e) => e.name === 'beta')!
    expect(entry.locations.map((l) => l.kind)).toEqual(['agents', 'codex', 'claude'])
    expect(entry.visibleTo).toEqual(['claude', 'codex'])
    // 主位置永远优先统一目录——打开/删除都以它为准。
    expect(entry.primary.kind).toBe('agents')
  })

  test('全局和项目同名是两条独立记录', () => {
    writeSkill(join(home, '.agents', 'skills'), 'dup')
    writeSkill(join(repo, '.agents', 'skills'), 'dup')

    const entries = scanSkills({ folderPaths: [repo] }).entries.filter((e) => e.name === 'dup')
    expect(entries.map((e) => e.id).sort()).toEqual(['global:dup', 'project:dup'])
  })

  test('claude 不扫项目的 .agents/skills——所以项目技能默认也只有 codex 看得到', () => {
    writeSkill(join(repo, '.agents', 'skills'), 'proj')
    const entry = scanSkills({ folderPaths: [repo] }).entries.find((e) => e.name === 'proj')!
    expect(entry.scope).toBe('project')
    expect(entry.folderPath).toBe(repo)
    expect(entry.visibleTo).toEqual(['codex'])
  })

  test('跳过点开头的目录——~/.codex/skills/.system 是 codex 内置的，不是用户的', () => {
    writeSkill(join(home, '.codex', 'skills'), '.system')
    expect(scanSkills().entries).toHaveLength(0)
  })

  test('没有 SKILL.md 的目录不算技能', () => {
    mkdirSync(join(home, '.agents', 'skills', 'references'), { recursive: true })
    expect(scanSkills().entries).toHaveLength(0)
  })

  test('frontmatter 缺 name 时退化成目录名', () => {
    const dir = join(home, '.agents', 'skills', 'no-name')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '# 没有 frontmatter\n')
    expect(scanSkills().entries[0]!.name).toBe('no-name')
  })
})

describe('createMirror', () => {
  test('建成软链后，两个后端都看得到', async () => {
    const source = writeSkill(join(home, '.agents', 'skills'), 'gamma')
    const link = join(home, '.claude', 'skills', 'gamma')

    const result = await createMirror(source, link)
    expect(result.ok).toBe(true)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)

    const entry = scanSkills().entries.find((e) => e.name === 'gamma')!
    expect(entry.visibleTo).toEqual(['claude', 'codex'])
    expect(entry.locations.find((l) => l.kind === 'claude')!.symlink).toBe(true)
  })

  test('目标位置是真目录时拒绝覆盖——那是用户自己的另一份副本', async () => {
    const source = writeSkill(join(home, '.agents', 'skills'), 'delta')
    const rival = writeSkill(join(home, '.claude', 'skills'), 'delta', '另一份独立副本')

    const result = await createMirror(source, rival)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('occupied-by-directory')
    // 关键：用户的文件必须原封不动。
    expect(existsSync(join(rival, 'SKILL.md'))).toBe(true)
    expect(lstatSync(rival).isSymbolicLink()).toBe(false)
  })

  test('别人建的、指向别处的软链不动它', async () => {
    const source = writeSkill(join(home, '.agents', 'skills'), 'eps')
    const elsewhere = writeSkill(join(home, 'elsewhere'), 'eps')
    const link = join(home, '.claude', 'skills', 'eps')
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    const { symlinkSync } = await import('node:fs')
    symlinkSync(elsewhere, link)

    const result = await createMirror(source, link)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('occupied-by-foreign-link')
  })

  test('已经指向同一处的软链：接管进清单，但不重建', async () => {
    // 本机那批 lark-* 就是这个形态（安装器建的，root 所有）。
    const source = writeSkill(join(home, '.agents', 'skills'), 'zeta')
    const link = join(home, '.claude', 'skills', 'zeta')
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    const { symlinkSync } = await import('node:fs')
    symlinkSync(source, link)
    expect(isManagedLink(link)).toBe(false)

    expect((await createMirror(source, link)).ok).toBe(true)
    expect(isManagedLink(link)).toBe(true)
  })
})

describe('removeMirror', () => {
  test('只删清单里的软链', async () => {
    const source = writeSkill(join(home, '.agents', 'skills'), 'eta')
    const link = join(home, '.claude', 'skills', 'eta')
    await createMirror(source, link)

    expect(await removeMirror(link)).toBe(true)
    expect(existsSync(link)).toBe(false)
    // 软链没了，它指向的真技能必须还在。
    expect(existsSync(join(source, 'SKILL.md'))).toBe(true)
  })

  test('不在清单里就拒绝，哪怕它确实是一条软链', async () => {
    const source = writeSkill(join(home, '.agents', 'skills'), 'theta')
    const link = join(home, '.claude', 'skills', 'theta')
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    const { symlinkSync } = await import('node:fs')
    symlinkSync(source, link)

    expect(await removeMirror(link)).toBe(false)
    expect(existsSync(link)).toBe(true)
  })

  test('真目录一律不删——这是最后一道保险', async () => {
    const real = writeSkill(join(home, '.claude', 'skills'), 'iota')
    expect(await removeMirror(real)).toBe(false)
    expect(existsSync(join(real, 'SKILL.md'))).toBe(true)
  })
})

describe('excludeFromGit', () => {
  test('写 .git/info/exclude，不碰 .gitignore', async () => {
    mkdirSync(join(repo, '.git'), { recursive: true })
    await excludeFromGit(repo, '.claude/skills/')

    const { readFileSync } = await import('node:fs')
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.claude/skills/')
    // .gitignore 是用户仓库里受版本控制的文件，catmax 不该往里塞东西。
    expect(existsSync(join(repo, '.gitignore'))).toBe(false)
  })

  test('重复调用不追加第二遍', async () => {
    mkdirSync(join(repo, '.git'), { recursive: true })
    await excludeFromGit(repo, '.claude/skills/')
    await excludeFromGit(repo, '.claude/skills/')

    const { readFileSync } = await import('node:fs')
    const lines = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() === '.claude/skills/')
    expect(lines).toHaveLength(1)
  })

  test('不是 git 仓库时安静跳过', async () => {
    await excludeFromGit(repo, '.claude/skills/')
    expect(existsSync(join(repo, '.git'))).toBe(false)
  })
})

describe('技能开关状态', () => {
  test('按名字存，扫描结果里的 enabled 跟着变', async () => {
    writeSkill(join(home, '.agents', 'skills'), 'kappa')
    expect(scanSkills().entries[0]!.enabled).toBe(true)

    await setSkillEnabled('kappa', false)
    expect(readDisabledSkills().has('kappa')).toBe(true)
    expect(scanSkills().entries[0]!.enabled).toBe(false)

    await setSkillEnabled('kappa', true)
    expect(scanSkills().entries[0]!.enabled).toBe(true)
  })

  /*
   * claude 侧的投影。全部启用时必须是 null 而不是空对象——调用方靠它决定
   * 走不走"完全不合并"那条路径（见 ClaudeAdapter.applyOverrideSettings），
   * 返回 {} 会让每个会话都无谓地把覆盖文件读一遍再内联传下去。
   */
  test('disabledSkillOverrides：没关任何技能时返回 null', async () => {
    expect(disabledSkillOverrides()).toBeNull()
    await setSkillEnabled('lambda', false)
    expect(disabledSkillOverrides()).toEqual({ lambda: 'off' })
  })

  test('mergeSkillOverrides：用户在覆盖文件里写的档位优先', () => {
    const merged = mergeSkillOverrides(
      { env: { FOO: '1' }, skillOverrides: { mu: 'name-only' } },
      { mu: 'off', nu: 'off' },
    )
    // mu 保留用户写的 name-only，nu 由开关补上；其它 key 原样带过去。
    expect(merged).toEqual({
      env: { FOO: '1' },
      skillOverrides: { mu: 'name-only', nu: 'off' },
    })
  })

  test('mergeSkillOverrides：覆盖文件里没有 skillOverrides 时也不炸', () => {
    expect(mergeSkillOverrides({ model: 'x' }, { xi: 'off' })).toEqual({
      model: 'x',
      skillOverrides: { xi: 'off' },
    })
  })
})

describe('isInsideFolder', () => {
  test('前缀相同但不是子目录的路径不算在内', () => {
    // `/repo-evil` 以 `/repo` 开头，但显然不在 `/repo` 里。少了分隔符判断
    // 这里就会放行，而它下游就是 removeSkill 的删除守卫。
    expect(isInsideFolder('/tmp/repo/skills/a', '/tmp/repo')).toBe(true)
    expect(isInsideFolder('/tmp/repo-evil/a', '/tmp/repo')).toBe(false)
    expect(isInsideFolder('/tmp/other', '/tmp/repo')).toBe(false)
  })
})
