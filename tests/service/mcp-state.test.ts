// @vitest-environment node
/**
 * Unified MCP Server Center: 开关状态的分桶与合并。
 *
 * 与 skill-state 最大的差异是这里有 global/project 两个桶。分桶不是为了整齐——
 * claude 的 `disabledMcpServers` 本身就住在 `projects.<abs>` 里、天然 per-project，
 * 而同名 server 在不同项目常常是不同配置（团队共享的 `.mcp.json` 尤其如此）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.userDataDir } }))

const { claudeDisabledNamesFor, isDisabled, readMcpState, setMcpEnabled, writeMcpState } =
  await import('@main/service/mcp-state')

let base = ''

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'catmax-mcp-state-'))
  mocks.userDataDir = join(base, 'userData')
  mkdirSync(mocks.userDataDir, { recursive: true })
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('分桶', () => {
  test('全局禁用影响所有作用域', async () => {
    await setMcpEnabled('weather', 'global', null, false)
    const state = readMcpState()
    expect(isDisabled(state, 'weather', 'global', null)).toBe(true)
    expect(isDisabled(state, 'weather', 'project', '/repo/a')).toBe(true)
  })

  test('项目禁用只影响该项目——不会误伤同名的另一个项目', async () => {
    await setMcpEnabled('weather', 'project', '/repo/a', false)
    const state = readMcpState()
    expect(isDisabled(state, 'weather', 'project', '/repo/a')).toBe(true)
    expect(isDisabled(state, 'weather', 'project', '/repo/b')).toBe(false)
    expect(isDisabled(state, 'weather', 'global', null)).toBe(false)
  })

  test('开启项目级 server 时会撤掉全局桶里的同名禁用', async () => {
    // 否则用户点了"开"却发现它还是关的（被全局桶挡着），
    // 这正是最难自查的那类"界面撒谎"。
    await setMcpEnabled('weather', 'global', null, false)
    await setMcpEnabled('weather', 'project', '/repo/a', true)
    const state = readMcpState()
    expect(isDisabled(state, 'weather', 'project', '/repo/a')).toBe(false)
    expect(state.globalDisabled).not.toContain('weather')
  })
})

describe('claude 投影', () => {
  test('全局禁用会展开到每个项目——claude 没有"全局禁用"的位置', async () => {
    await setMcpEnabled('a', 'global', null, false)
    await setMcpEnabled('b', 'project', '/repo/x', false)
    const state = readMcpState()
    expect(claudeDisabledNamesFor(state, '/repo/x')).toEqual(['a', 'b'])
    // 另一个项目只继承全局那条
    expect(claudeDisabledNamesFor(state, '/repo/y')).toEqual(['a'])
  })
})

describe('持久化', () => {
  test('写入后能读回，且去重排序', async () => {
    await writeMcpState({
      globalDisabled: ['z', 'a', 'a'],
      projectDisabled: { '/repo/x': ['c', 'b', 'b'] },
      injected: { codex: [], claude: [] },
    })
    const state = readMcpState()
    expect(state.globalDisabled).toEqual(['a', 'z'])
    expect(state.projectDisabled['/repo/x']).toEqual(['b', 'c'])
  })

  test('空的项目桶不落盘', async () => {
    await writeMcpState({
      globalDisabled: [],
      projectDisabled: { '/repo/x': [] },
      injected: { codex: [], claude: [] },
    })
    expect(readMcpState().projectDisabled).toEqual({})
  })

  test('状态文件坏了就当全部启用——方向是安全的', () => {
    writeFileSync(join(mocks.userDataDir, 'mcp-state.json'), '{ broken')
    const state = readMcpState()
    // 用户会看到一个本该关闭的 server 还开着（可见、可再关），
    // 而不是反过来"以为关了其实开着"。
    expect(state.globalDisabled).toEqual([])
    expect(isDisabled(state, 'anything', 'global', null)).toBe(false)
  })

  test('状态文件不存在时返回空状态', () => {
    expect(readMcpState()).toEqual({
      globalDisabled: [],
      projectDisabled: {},
      injected: { codex: [], claude: [] },
    })
  })

  test('回归：空状态不能是共享引用', async () => {
    // 曾经的写法是 `const EMPTY = {...}` + `return { ...EMPTY }`——浅拷贝让
    // projectDisabled 与模块级常量共享引用，而 setMcpEnabled 是就地写，
    // 一次调用就把"空状态"永久污染了。表现是：文件不存在/损坏时读出来的
    // 竟然带着上一次的禁用项。
    await setMcpEnabled('poison', 'project', '/repo/a', false)
    rmSync(join(mocks.userDataDir, 'mcp-state.json'), { force: true })
    expect(readMcpState()).toEqual({
      globalDisabled: [],
      projectDisabled: {},
      injected: { codex: [], claude: [] },
    })
  })
})
