// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// 备份目录取自 app.getPath('userData')——mock 掉 electron 把备份也关进临时目录，
// 否则测试会往真实的 ~/.catmax 里写东西。
const mocks = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.userDataDir } }))

const {
  catmaxBackendConfigDir,
  claudeOverrideSettingsPath,
  listBackendConfigFiles,
  readBackendConfigFile,
  resolveBackendConfigDir,
  validateBackendConfigContent,
  validateConfigSyntax,
  writeBackendConfigFile,
} = await import('@main/service/backend-config-files')

// CODEX_HOME / CLAUDE_CONFIG_DIR 就是生产代码解析配置目录的方式，
// 测试直接用它们把两个后端指到临时目录，不用 mock fs。
let tempDir: string
const originalEnv = {
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'catmax-backend-config-'))
  mocks.userDataDir = join(tempDir, 'userData')
  process.env.CODEX_HOME = join(tempDir, 'codex')
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'claude')
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('resolveBackendConfigDir', () => {
  test('跟随后端自己的环境变量覆盖，而不是写死 ~/.codex', () => {
    expect(resolveBackendConfigDir('codex')).toBe(join(tempDir, 'codex'))
    expect(resolveBackendConfigDir('claude')).toBe(join(tempDir, 'claude'))
  })

  test('未知 backend 退回 ~/.<id> 约定', () => {
    expect(resolveBackendConfigDir('pi-agent').endsWith('.pi-agent')).toBe(true)
  })
})

describe('validateConfigSyntax', () => {
  test('合法 TOML / JSON 通过', () => {
    expect(validateConfigSyntax('toml', 'model = "gpt-5-codex"')).toEqual({ ok: true })
    expect(validateConfigSyntax('json', '{"env": {}}')).toEqual({ ok: true })
  })

  test('TOML 语法错带出行列', () => {
    const result = validateConfigSyntax('toml', 'model = \nfoo')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.line).toBeGreaterThanOrEqual(1)
  })

  test('JSON 语法错带出行列', () => {
    const result = validateConfigSyntax('json', '{\n  "a": 1,\n}')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.line).not.toBeNull()
  })

  test('空内容：TOML 是空表（合法），JSON 不是', () => {
    expect(validateConfigSyntax('toml', '   \n').ok).toBe(true)
    expect(validateConfigSyntax('json', '   \n').ok).toBe(false)
  })

  test('顶层是数组的 JSON 被拒——后端配置一定是对象', () => {
    expect(validateConfigSyntax('json', '[1, 2]').ok).toBe(false)
  })

  test('按文件 id 校验时用该文件声明的格式', () => {
    // config.toml 声明 toml：一段合法 JSON 对 TOML 来说是语法错
    expect(validateBackendConfigContent('codex.config', '{"a": 1}').ok).toBe(false)
    expect(validateBackendConfigContent('claude.settings', '{"a": 1}').ok).toBe(true)
  })

  test('未知 id 抛错——renderer 传不进白名单外的文件', () => {
    expect(() => validateBackendConfigContent('evil.passwd', '{}')).toThrow(/未知的后端配置文件/)
  })
})

// catmax 覆盖层：这一份文件 catmax 自己拥有，编辑它绝不能碰用户的 ~/.claude。
// 这几条是整个特性的核心保证，回归了就等于"应用里改配置把用户本地配置覆盖了"。
describe('claude.catmaxSettings（catmax 覆盖层）', () => {
  test('落在 catmax userData，而不是后端配置目录', () => {
    const info = listBackendConfigFiles().find((f) => f.id === 'claude.catmaxSettings')
    expect(info?.location).toBe('catmax-userdata')
    expect(info?.path).toBe(join(catmaxBackendConfigDir(), 'claude-settings.json'))
    // 关键否定断言：不在 CLAUDE_CONFIG_DIR 下
    expect(info?.path.startsWith(join(tempDir, 'claude'))).toBe(false)
  })

  test('保存覆盖层不产生 ~/.claude 里的任何文件', () => {
    const claudeHome = join(tempDir, 'claude')
    mkdirSync(claudeHome, { recursive: true })
    writeFileSync(join(claudeHome, 'settings.json'), '{"model":"local-model"}\n')

    const result = writeBackendConfigFile({
      id: 'claude.catmaxSettings',
      content: '{"model":"override-model"}\n',
      expectedMtimeMs: null,
    })
    expect(result.ok).toBe(true)

    // 用户本地文件内容一字未改，目录里也没多出文件
    expect(readFileSync(join(claudeHome, 'settings.json'), 'utf-8')).toBe(
      '{"model":"local-model"}\n',
    )
    expect(readdirSync(claudeHome)).toEqual(['settings.json'])
  })

  test('声明为 sensitive：写盘强制 0600', () => {
    writeBackendConfigFile({
      id: 'claude.catmaxSettings',
      content: '{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-test"}}\n',
      expectedMtimeMs: null,
    })
    const path = join(catmaxBackendConfigDir(), 'claude-settings.json')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('claudeOverrideSettingsPath：不存在返回 null，存在返回绝对路径', () => {
    // 不存在必须是 null——adapter 据此决定不给 SDK 传 settings，
    // 等价于"完全走用户本地配置"；传不存在的路径会让 SDK 直接报错。
    expect(claudeOverrideSettingsPath()).toBeNull()

    writeBackendConfigFile({
      id: 'claude.catmaxSettings',
      content: '{}\n',
      expectedMtimeMs: null,
    })
    expect(claudeOverrideSettingsPath()).toBe(join(catmaxBackendConfigDir(), 'claude-settings.json'))
  })

  test('和 claude.settings 是两个互不干扰的文件', () => {
    writeBackendConfigFile({
      id: 'claude.settings',
      content: '{"model":"local"}\n',
      expectedMtimeMs: null,
    })
    writeBackendConfigFile({
      id: 'claude.catmaxSettings',
      content: '{"model":"override"}\n',
      expectedMtimeMs: null,
    })
    expect(readBackendConfigFile('claude.settings').content).toBe('{"model":"local"}\n')
    expect(readBackendConfigFile('claude.catmaxSettings').content).toBe('{"model":"override"}\n')
  })
})

describe('listBackendConfigFiles', () => {
  test('文件不存在时 exists=false 且 mtimeMs=null', () => {
    const files = listBackendConfigFiles()
    expect(files.map((f) => f.id).sort()).toEqual([
      'claude.catmaxSettings',
      'claude.settings',
      'codex.auth',
      'codex.config',
    ])
    for (const file of files) {
      expect(file.exists).toBe(false)
      expect(file.mtimeMs).toBeNull()
    }
  })

  test('文件存在后带出大小和 mtime', () => {
    mkdirSync(join(tempDir, 'codex'), { recursive: true })
    writeFileSync(join(tempDir, 'codex', 'config.toml'), 'model = "x"\n')
    const file = listBackendConfigFiles().find((f) => f.id === 'codex.config')!
    expect(file.exists).toBe(true)
    expect(file.size).toBeGreaterThan(0)
    expect(file.mtimeMs).not.toBeNull()
  })
})

describe('readBackendConfigFile', () => {
  test('文件不存在时返回模板而不是空串', () => {
    const result = readBackendConfigFile('codex.config')
    expect(result.usingTemplate).toBe(true)
    expect(result.exists).toBe(false)
    expect(result.content).toContain('model')
  })

  test('文件存在时返回磁盘内容', () => {
    mkdirSync(join(tempDir, 'claude'), { recursive: true })
    writeFileSync(join(tempDir, 'claude', 'settings.json'), '{"model": "opus"}')
    const result = readBackendConfigFile('claude.settings')
    expect(result.usingTemplate).toBe(false)
    expect(result.content).toBe('{"model": "opus"}')
  })
})

describe('writeBackendConfigFile', () => {
  test('语法错时拒写，磁盘上原文件不动', () => {
    mkdirSync(join(tempDir, 'codex'), { recursive: true })
    const path = join(tempDir, 'codex', 'config.toml')
    writeFileSync(path, 'model = "old"\n')
    const mtimeMs = statSync(path).mtimeMs

    const result = writeBackendConfigFile({
      id: 'codex.config',
      content: 'model = \nbroken',
      expectedMtimeMs: mtimeMs,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-syntax')
    expect(readFileSync(path, 'utf-8')).toBe('model = "old"\n')
  })

  test('文件不存在时创建，并顺带建出配置目录', () => {
    const result = writeBackendConfigFile({
      id: 'codex.config',
      content: 'model = "gpt-5-codex"\n',
      expectedMtimeMs: null,
    })
    expect(result.ok).toBe(true)
    const path = join(tempDir, 'codex', 'config.toml')
    expect(readFileSync(path, 'utf-8')).toBe('model = "gpt-5-codex"\n')
    if (result.ok) {
      expect(result.info.exists).toBe(true)
      // 新建的文件没有旧内容可备份
      expect(result.backupPath).toBeNull()
    }
  })

  test('覆盖前把旧内容备份下来', () => {
    const path = join(tempDir, 'codex', 'config.toml')
    mkdirSync(join(tempDir, 'codex'), { recursive: true })
    writeFileSync(path, 'model = "old"\n')

    const result = writeBackendConfigFile({
      id: 'codex.config',
      content: 'model = "new"\n',
      expectedMtimeMs: statSync(path).mtimeMs,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.backupPath).not.toBeNull()
      expect(readFileSync(result.backupPath!, 'utf-8')).toBe('model = "old"\n')
    }
    expect(readFileSync(path, 'utf-8')).toBe('model = "new"\n')
  })

  test('mtime 对不上时返回 conflict 而不是覆盖', () => {
    const path = join(tempDir, 'claude', 'settings.json')
    mkdirSync(join(tempDir, 'claude'), { recursive: true })
    writeFileSync(path, '{"model": "disk"}')

    const result = writeBackendConfigFile({
      id: 'claude.settings',
      content: '{"model": "mine"}',
      // 用户读到的是更早的一版
      expectedMtimeMs: statSync(path).mtimeMs - 60_000,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('conflict')
    expect(readFileSync(path, 'utf-8')).toBe('{"model": "disk"}')
  })

  test('force=true 跳过冲突检查，强行覆盖', () => {
    const path = join(tempDir, 'claude', 'settings.json')
    mkdirSync(join(tempDir, 'claude'), { recursive: true })
    writeFileSync(path, '{"model": "disk"}')

    const result = writeBackendConfigFile({
      id: 'claude.settings',
      content: '{"model": "mine"}',
      expectedMtimeMs: statSync(path).mtimeMs - 60_000,
      force: true,
    })

    expect(result.ok).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe('{"model": "mine"}')
  })

  test('调用方以为文件不存在、实际已存在时也算冲突', () => {
    const path = join(tempDir, 'codex', 'config.toml')
    mkdirSync(join(tempDir, 'codex'), { recursive: true })
    writeFileSync(path, 'model = "created-by-codex-login"\n')

    const result = writeBackendConfigFile({
      id: 'codex.config',
      content: 'model = "mine"\n',
      expectedMtimeMs: null,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('conflict')
  })

  test('敏感文件强制 0600，且不受 umask 影响', () => {
    const result = writeBackendConfigFile({
      id: 'codex.auth',
      content: '{"OPENAI_API_KEY": "sk-test"}',
      expectedMtimeMs: null,
    })
    expect(result.ok).toBe(true)
    const mode = statSync(join(tempDir, 'codex', 'auth.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test('普通配置文件沿用已有权限位', () => {
    const path = join(tempDir, 'codex', 'config.toml')
    mkdirSync(join(tempDir, 'codex'), { recursive: true })
    writeFileSync(path, 'model = "old"\n', { mode: 0o640 })

    writeBackendConfigFile({
      id: 'codex.config',
      content: 'model = "new"\n',
      expectedMtimeMs: statSync(path).mtimeMs,
    })

    expect(statSync(path).mode & 0o777).toBe(0o640)
  })

  test('写完不留临时文件', () => {
    writeBackendConfigFile({
      id: 'codex.config',
      content: 'model = "x"\n',
      expectedMtimeMs: null,
    })
    const leftovers = readdirSync(join(tempDir, 'codex')).filter((n) => n.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  test('未知 id 抛错', () => {
    expect(() =>
      writeBackendConfigFile({ id: '../../etc/passwd', content: '{}', expectedMtimeMs: null }),
    ).toThrow(/未知的后端配置文件/)
    expect(existsSync(join(tempDir, 'codex'))).toBe(false)
  })
})

describe('备份轮转', () => {
  test('只保留最近 10 份', () => {
    const path = join(tempDir, 'codex', 'config.toml')
    let backupDir: string | null = null

    // 写 13 次 → 12 份备份（第一次是新建，没有旧内容），轮转后应剩 10 份
    for (let i = 0; i < 13; i++) {
      const expectedMtimeMs = existsSync(path) ? statSync(path).mtimeMs : null
      const result = writeBackendConfigFile({
        id: 'codex.config',
        content: `model = "v${i}"\n`,
        expectedMtimeMs,
      })
      expect(result.ok).toBe(true)
      if (result.ok && result.backupPath) backupDir = join(result.backupPath, '..')
    }

    expect(backupDir).not.toBeNull()
    const backups = readdirSync(backupDir!).filter((n) => n.endsWith('.bak'))
    expect(backups.length).toBe(10)
  })
})
