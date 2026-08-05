// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// 档目录取自 app.getPath('userData')——mock 掉 electron 把它关进临时目录，
// 否则测试会往真实的 ~/.catmax 里写东西。
const mocks = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.userDataDir } }))

const {
  claudeProfilesDir,
  createClaudeSettingsProfile,
  currentClaudeProfilePath,
  deleteClaudeSettingsProfile,
  ensureInternalBetaProfile,
  hasCurrentClaudeProfile,
  listClaudeSettingsProfiles,
  removeInternalBetaProfile,
  renameClaudeSettingsProfile,
  selectClaudeSettingsProfile,
} = await import('@main/service/claude-settings-profiles')

const { writeBackendConfigFile } = await import('@main/service/backend-config-files')

const {
  INTERNAL_BETA_PROFILE_ID,
  MAX_CLAUDE_SETTINGS_PROFILES,
  NO_CLAUDE_SETTINGS_PROFILE,
} = await import('@shared/backend/claude-settings-profiles')

let tempDir: string
let backendSettingsDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'catmax-claude-profiles-'))
  mocks.userDataDir = join(tempDir, 'userData')
  backendSettingsDir = join(mocks.userDataDir, 'backend-settings')
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

/** 往当前档写内容——走的是生产路径（按当前档解析），不是直接拼文件名 */
function writeCurrent(content: string): void {
  const result = writeBackendConfigFile({
    id: 'claude.catmaxSettings',
    content,
    expectedMtimeMs: null,
    force: true,
  })
  expect(result.ok).toBe(true)
}

function readCurrent(): string {
  const path = currentClaudeProfilePath()
  expect(path).not.toBeNull()
  return readFileSync(path as string, 'utf-8')
}

describe('单档 → 多档迁移', () => {
  test('旧的 claude-settings.json 被收编成第一档并自动选中', () => {
    mkdirSync(backendSettingsDir, { recursive: true })
    writeFileSync(join(backendSettingsDir, 'claude-settings.json'), '{"model":"legacy"}\n')

    const snapshot = listClaudeSettingsProfiles()
    expect(snapshot.profiles).toHaveLength(1)
    expect(snapshot.currentId).toBe(snapshot.profiles[0]!.id)
    // 内容一字不差地跟过来了——迁移不能悄悄丢用户的配置
    expect(readCurrent()).toBe('{"model":"legacy"}\n')
  })

  test('旧文件改名保留而不是删除，且不会被二次收编', () => {
    mkdirSync(backendSettingsDir, { recursive: true })
    writeFileSync(join(backendSettingsDir, 'claude-settings.json'), '{"model":"legacy"}\n')

    listClaudeSettingsProfiles()
    expect(existsSync(join(backendSettingsDir, 'claude-settings.json'))).toBe(false)
    expect(readFileSync(join(backendSettingsDir, 'claude-settings.json.migrated'), 'utf-8')).toBe(
      '{"model":"legacy"}\n',
    )

    // 再读一次不会又冒出一档
    expect(listClaudeSettingsProfiles().profiles).toHaveLength(1)
  })

  test('全新用户没有旧文件时是"不启用覆盖"，而不是凭空造一档', () => {
    const snapshot = listClaudeSettingsProfiles()
    expect(snapshot.profiles).toHaveLength(0)
    expect(snapshot.currentId).toBe(NO_CLAUDE_SETTINGS_PROFILE)
    expect(currentClaudeProfilePath()).toBeNull()
    expect(hasCurrentClaudeProfile()).toBe(false)
  })
})

describe('增删改查', () => {
  test('新建即选中，且不预先落盘文件（编辑器应显示模板）', () => {
    const snapshot = createClaudeSettingsProfile({ name: 'DeepSeek 中转' })
    expect(snapshot.profiles).toHaveLength(1)
    expect(snapshot.currentId).toBe(snapshot.profiles[0]!.id)
    expect(snapshot.profiles[0]!.name).toBe('DeepSeek 中转')
    expect(snapshot.profiles[0]!.exists).toBe(false)
  })

  test('切换只改指针——别的档内容一个字节都不动', () => {
    const first = createClaudeSettingsProfile({ name: 'A' }).currentId
    writeCurrent('{"model":"a"}\n')
    const second = createClaudeSettingsProfile({ name: 'B' }).currentId
    writeCurrent('{"model":"b"}\n')

    selectClaudeSettingsProfile({ id: first })
    expect(readCurrent()).toBe('{"model":"a"}\n')
    selectClaudeSettingsProfile({ id: second })
    expect(readCurrent()).toBe('{"model":"b"}\n')
  })

  test('选「不启用」后不再注入任何覆盖', () => {
    createClaudeSettingsProfile({ name: 'A' })
    writeCurrent('{"model":"a"}\n')

    selectClaudeSettingsProfile({ id: NO_CLAUDE_SETTINGS_PROFILE })
    expect(currentClaudeProfilePath()).toBeNull()
    expect(hasCurrentClaudeProfile()).toBe(false)
    // 档还在，切回去内容仍然完好
    expect(listClaudeSettingsProfiles().profiles).toHaveLength(1)
  })

  test('另存为复制内容，之后两档互不影响', () => {
    const source = createClaudeSettingsProfile({ name: '源' }).currentId
    writeCurrent('{"model":"source"}\n')

    createClaudeSettingsProfile({ name: '副本', copyFromId: source })
    expect(readCurrent()).toBe('{"model":"source"}\n')

    writeCurrent('{"model":"copy"}\n')
    selectClaudeSettingsProfile({ id: source })
    expect(readCurrent()).toBe('{"model":"source"}\n')
  })

  test('删除当前档后回落到剩下的第一档，文件也一并删掉', () => {
    const first = createClaudeSettingsProfile({ name: 'A' }).currentId
    writeCurrent('{"model":"a"}\n')
    const second = createClaudeSettingsProfile({ name: 'B' }).currentId
    writeCurrent('{"model":"b"}\n')
    const secondPath = currentClaudeProfilePath() as string

    const snapshot = deleteClaudeSettingsProfile({ id: second })
    expect(snapshot.currentId).toBe(first)
    expect(existsSync(secondPath)).toBe(false)
    expect(readCurrent()).toBe('{"model":"a"}\n')
  })

  test('删掉最后一档后回落到"不启用"', () => {
    const only = createClaudeSettingsProfile({ name: 'A' }).currentId
    const snapshot = deleteClaudeSettingsProfile({ id: only })
    expect(snapshot.currentId).toBe(NO_CLAUDE_SETTINGS_PROFILE)
    expect(currentClaudeProfilePath()).toBeNull()
  })

  test('改名不动内容', () => {
    const id = createClaudeSettingsProfile({ name: '旧名' }).currentId
    writeCurrent('{"model":"x"}\n')
    const snapshot = renameClaudeSettingsProfile({ id, name: '新名' })
    expect(snapshot.profiles[0]!.name).toBe('新名')
    expect(readCurrent()).toBe('{"model":"x"}\n')
  })

  test('空名字回落成占位名，不产生一个看不见的档', () => {
    const snapshot = createClaudeSettingsProfile({ name: '   ' })
    expect(snapshot.profiles[0]!.name).toBe('未命名配置')
  })

  test('未知 id 一律抛错——renderer 传不进白名单外的档', () => {
    expect(() => selectClaudeSettingsProfile({ id: 'nope' })).toThrow(/未知的配置档/)
    expect(() => renameClaudeSettingsProfile({ id: 'nope', name: 'x' })).toThrow(/未知的配置档/)
    expect(() => deleteClaudeSettingsProfile({ id: 'nope' })).toThrow(/未知的配置档/)
  })

  test('档数上限挡住无限新建', () => {
    for (let i = 0; i < MAX_CLAUDE_SETTINGS_PROFILES; i++) {
      createClaudeSettingsProfile({ name: `配置 ${i}` })
    }
    expect(() => createClaudeSettingsProfile({ name: '再来一个' })).toThrow(/最多只能保存/)
  })
})

describe('内测登录档', () => {
  test('登录只影响自己那一档，用户手写的档原样保留', () => {
    const mine = createClaudeSettingsProfile({ name: '我的配置' }).currentId
    writeCurrent('{"model":"mine"}\n')

    // 登录：切到内测档并写入内测默认配置
    ensureInternalBetaProfile()
    writeCurrent('{"model":"internal-beta"}\n')
    expect(listClaudeSettingsProfiles().currentId).toBe(INTERNAL_BETA_PROFILE_ID)

    selectClaudeSettingsProfile({ id: mine })
    expect(readCurrent()).toBe('{"model":"mine"}\n')
  })

  test('登出连档带密钥文件一起删，当前档回落到用户自己的档', () => {
    const mine = createClaudeSettingsProfile({ name: '我的配置' }).currentId
    writeCurrent('{"model":"mine"}\n')
    ensureInternalBetaProfile()
    writeCurrent('{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-secret"}}\n')
    const betaPath = currentClaudeProfilePath() as string

    removeInternalBetaProfile()
    expect(existsSync(betaPath)).toBe(false)
    expect(listClaudeSettingsProfiles().currentId).toBe(mine)
    expect(readCurrent()).toBe('{"model":"mine"}\n')
  })

  test('重复登录不会堆出多份内测档', () => {
    ensureInternalBetaProfile()
    ensureInternalBetaProfile()
    const profiles = listClaudeSettingsProfiles().profiles
    expect(profiles.filter((p) => p.id === INTERNAL_BETA_PROFILE_ID)).toHaveLength(1)
    expect(profiles[0]!.managed).toBe(true)
  })

  test('内测档不允许改名 / 删除——那会让登录态和档对不上', () => {
    ensureInternalBetaProfile()
    expect(() =>
      renameClaudeSettingsProfile({ id: INTERNAL_BETA_PROFILE_ID, name: 'x' }),
    ).toThrow(/内置配置/)
    expect(() => deleteClaudeSettingsProfile({ id: INTERNAL_BETA_PROFILE_ID })).toThrow(
      /内置配置/,
    )
  })
})

describe('损坏的 index.json', () => {
  test('解析不了时退化成"没有档"，而不是让设置页起不来', () => {
    mkdirSync(claudeProfilesDir(), { recursive: true })
    writeFileSync(join(claudeProfilesDir(), 'index.json'), '{ 这不是 JSON')
    expect(listClaudeSettingsProfiles().profiles).toHaveLength(0)
    expect(currentClaudeProfilePath()).toBeNull()
  })

  test('带路径分隔符的档 id 被丢弃——它会直接参与文件名拼接', () => {
    mkdirSync(claudeProfilesDir(), { recursive: true })
    writeFileSync(
      join(claudeProfilesDir(), 'index.json'),
      JSON.stringify({
        currentId: '../../evil',
        profiles: [
          { id: '../../evil', name: 'evil', createdAt: 1, managed: false },
          { id: 'ok-1', name: '正常', createdAt: 2, managed: false },
        ],
      }),
    )
    const snapshot = listClaudeSettingsProfiles()
    expect(snapshot.profiles.map((p) => p.id)).toEqual(['ok-1'])
    // currentId 指向被丢弃的条目 → 回落成"不启用"，而不是留一个指向仓库外的路径
    expect(snapshot.currentId).toBe(NO_CLAUDE_SETTINGS_PROFILE)
  })

  test('空索引不会被后续新建污染（共享常量的浅拷贝坑）', () => {
    // 第一轮：读到坏索引 → 空 → 新建一档
    mkdirSync(claudeProfilesDir(), { recursive: true })
    writeFileSync(join(claudeProfilesDir(), 'index.json'), 'garbage')
    createClaudeSettingsProfile({ name: 'A' })

    // 换一个全新的 userData：这里必须还是 0 档
    mocks.userDataDir = join(tempDir, 'userData2')
    expect(listClaudeSettingsProfiles().profiles).toHaveLength(0)
  })
})
