// @vitest-environment node
/**
 * Unified MCP Server Center: claude 侧开关投影的写入。
 *
 * 这个文件写的是用户 86KB 的 `~/.claude.json`——里面有登录态、全部项目历史和明文
 * 凭据。所以这组用例守的不是"功能对不对"，而是**"写坏了会怎样"**：解析失败时
 * 拒绝写、只动一个键、权限位保持 0600、失败不留半个文件。
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.userDataDir } }))

const { writeClaudeDisabledServers, writeClaudeServer } =
  await import('@main/service/mcp-claude-writer')

let base = ''
let home = ''
let claudeJson = ''
const saved: Record<string, string | undefined> = {}

function stashEnv(key: string, value?: string): void {
  saved[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function write(obj: unknown, indent: number | undefined = 2): void {
  writeFileSync(claudeJson, JSON.stringify(obj, null, indent), { mode: 0o600 })
  chmodSync(claudeJson, 0o600)
}

/* eslint-disable @typescript-eslint/no-explicit-any -- 断言用的是任意深度的 JSON 结构 */
function read(): any {
  return JSON.parse(readFileSync(claudeJson, 'utf8'))
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'catmax-cw-'))
  home = join(base, 'home')
  mkdirSync(home, { recursive: true })
  mocks.userDataDir = join(base, 'userData')
  mkdirSync(mocks.userDataDir, { recursive: true })
  claudeJson = join(home, '.claude.json')
  stashEnv('HOME', home)
  stashEnv('CLAUDE_CONFIG_DIR', undefined)
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(base, { recursive: true, force: true })
})

describe('写入', () => {
  test('写进对应项目桶的 disabledMcpServers', async () => {
    write({ projects: { '/repo/a': { mcpServers: {} } } })
    await writeClaudeDisabledServers(new Map([['/repo/a', ['weather', 'github']]]))
    expect(read().projects['/repo/a'].disabledMcpServers).toEqual(['github', 'weather'])
  })

  test('名单是全集不是增量——外部删掉一条要能被覆盖回来', async () => {
    // disabledMcpServers 本身就是一张完整名单，增量式地往里加会让"用户在别处
    // 手动删掉一条"永远补不回去。
    write({ projects: { '/repo/a': { disabledMcpServers: ['stale', 'weather'] } } })
    await writeClaudeDisabledServers(new Map([['/repo/a', ['weather']]]))
    expect(read().projects['/repo/a'].disabledMcpServers).toEqual(['weather'])
  })

  test('空名单删掉这个键，而不是留一个 []', async () => {
    write({ projects: { '/repo/a': { disabledMcpServers: ['weather'] } } })
    await writeClaudeDisabledServers(new Map([['/repo/a', []]]))
    expect('disabledMcpServers' in read().projects['/repo/a']).toBe(false)
  })

  test('只动这一个键，项目桶里其它东西原样保留', async () => {
    // 这个桶里还有会话历史、onboarding 状态等等，任何"顺手规整"都是拿用户数据冒险。
    write({
      numStartups: 42,
      projects: {
        '/repo/a': { mcpServers: { x: { command: 'y' } }, history: [1, 2, 3], hasTrust: true },
      },
    })
    await writeClaudeDisabledServers(new Map([['/repo/a', ['weather']]]))
    const out = read()
    expect(out.numStartups).toBe(42)
    expect(out.projects['/repo/a'].history).toEqual([1, 2, 3])
    expect(out.projects['/repo/a'].mcpServers).toEqual({ x: { command: 'y' } })
    expect(out.projects['/repo/a'].hasTrust).toBe(true)
  })

  test('没变化就不重写——避免无谓地改 mtime 和触发 claude 的文件监听', async () => {
    write({ projects: { '/repo/a': { disabledMcpServers: ['weather'] } } })
    const before = statSync(claudeJson).mtimeMs
    await new Promise((r) => setTimeout(r, 12))
    await writeClaudeDisabledServers(new Map([['/repo/a', ['weather']]]))
    expect(statSync(claudeJson).mtimeMs).toBe(before)
  })
})

describe('安全', () => {
  test('写完仍是 0600——这个文件里有明文凭据', async () => {
    write({ projects: { '/repo/a': {} } })
    await writeClaudeDisabledServers(new Map([['/repo/a', ['weather']]]))
    expect(statSync(claudeJson).mode & 0o777).toBe(0o600)
  })

  test('不留任何备份副本', async () => {
    // 备份等于多一处 catmax 没在管的密钥副本，收益（回滚一个布尔）远小于代价。
    write({ projects: { '/repo/a': {} } })
    await writeClaudeDisabledServers(new Map([['/repo/a', ['weather']]]))
    const files = await readdir(home)
    expect(files).toEqual(['.claude.json'])
  })

  test('JSON 坏了就什么都不做，绝不重建', async () => {
    // 重建一个"干净的"会把用户的登录态和全部项目历史一次性抹掉。
    writeFileSync(claudeJson, '{ 这不是 JSON', { mode: 0o600 })
    await writeClaudeDisabledServers(new Map([['/repo/a', ['weather']]]))
    expect(readFileSync(claudeJson, 'utf8')).toBe('{ 这不是 JSON')
  })

  test('文件不存在就不创建——claude 自己会建，替它造壳可能干扰 onboarding', async () => {
    await writeClaudeDisabledServers(new Map([['/repo/a', ['weather']]]))
    expect(existsSync(claudeJson)).toBe(false)
  })

  test('项目桶不存在时不凭空创建', async () => {
    // 往用户配置里加一个他没在 claude 里打开过的项目，是在替他做决定。
    write({ projects: {} })
    await writeClaudeDisabledServers(new Map([['/repo/never-opened', ['weather']]]))
    expect(read().projects).toEqual({})
  })
})

describe('格式', () => {
  test('保持缩进——把 86KB 的文件压成一行会让用户自己没法读', async () => {
    write({ projects: { '/repo/a': {} } }, 2)
    await writeClaudeDisabledServers(new Map([['/repo/a', ['weather']]]))
    expect(readFileSync(claudeJson, 'utf8')).toMatch(/^\{\n {2}"/)
  })

  test('原文是压缩的就保持压缩——展开会让它膨胀几倍', async () => {
    // 不能走 write(obj, undefined)：JS 的默认参数对 undefined 生效，那样还是 2 空格。
    writeFileSync(claudeJson, JSON.stringify({ projects: { '/repo/a': {} } }), { mode: 0o600 })
    await writeClaudeDisabledServers(new Map([['/repo/a', ['weather']]]))
    expect(readFileSync(claudeJson, 'utf8')).toMatch(/^\{"projects"/)
  })
})

describe('写入 / 删除整条 server 定义', () => {
  test('全局写进顶层 mcpServers', async () => {
    write({ mcpServers: {}, projects: {} })
    const path = await writeClaudeServer(
      'weather',
      { type: 'stdio', command: 'npx', args: ['-y', 'w'] },
      { scope: 'global' },
    )
    expect(path).toBe(claudeJson)
    expect(read().mcpServers.weather).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'w'] })
  })

  test('项目级写进 projects.<abs>.mcpServers', async () => {
    write({ projects: { '/repo/a': {} } })
    await writeClaudeServer(
      'weather',
      { type: 'stdio', command: 'x' },
      {
        scope: 'project',
        folderPath: '/repo/a',
      },
    )
    expect(read().projects['/repo/a'].mcpServers.weather).toEqual({ type: 'stdio', command: 'x' })
  })

  test('传 null 即删除', async () => {
    write({ mcpServers: { weather: { command: 'x' }, other: { command: 'y' } } })
    await writeClaudeServer('weather', null, { scope: 'global' })
    expect(Object.keys(read().mcpServers)).toEqual(['other'])
  })

  test('删一个本来就不存在的，不重写文件', async () => {
    write({ mcpServers: { other: { command: 'y' } } })
    const before = statSync(claudeJson).mtimeMs
    await new Promise((r) => setTimeout(r, 12))
    expect(await writeClaudeServer('ghost', null, { scope: 'global' })).toBeNull()
    expect(statSync(claudeJson).mtimeMs).toBe(before)
  })

  test('写入不碰其它键，且仍是 0600', async () => {
    write({ numStartups: 7, mcpServers: { other: { command: 'y' } } })
    await writeClaudeServer('weather', { command: 'x' }, { scope: 'global' })
    const out = read()
    expect(out.numStartups).toBe(7)
    expect(out.mcpServers.other).toEqual({ command: 'y' })
    expect(statSync(claudeJson).mode & 0o777).toBe(0o600)
  })

  test('项目桶不存在时不写——那等于替用户新增一个他没打开过的项目', async () => {
    write({ projects: {} })
    expect(
      await writeClaudeServer(
        'weather',
        { command: 'x' },
        {
          scope: 'project',
          folderPath: '/repo/never-opened',
        },
      ),
    ).toBeNull()
    expect(read().projects).toEqual({})
  })

  test('JSON 坏了照样拒绝写', async () => {
    writeFileSync(claudeJson, '{ 坏的', { mode: 0o600 })
    expect(await writeClaudeServer('weather', { command: 'x' }, { scope: 'global' })).toBeNull()
    expect(readFileSync(claudeJson, 'utf8')).toBe('{ 坏的')
  })
})
