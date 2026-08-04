/**
 * Unified MCP Server Center: 两端 MCP 运行时状态的归一。
 *
 * 下面的原始载荷都是**实测抄回来的**（codex 0.145.0 的 mcpServerStatus/list、
 * claude 2.1.220 的 mcpServerStatus()），不是照类型定义编的——这两端的响应形状
 * 差异很大（tools 一个是 map 一个是数组、状态字段一个有一个没有），照定义想当然
 * 正是最容易写错的地方。
 */
import {
  allSettled,
  applyCodexStartupState,
  attachRuntime,
  mapClaudeMcpStatus,
  mapCodexMcpStatus,
} from '@main/backend/shared/mcp-runtime-mapping'
import type { BackendId } from '@shared/constants'
import type { McpEntry, McpRuntimeStatus, McpSnapshot } from '@shared/mcp/types'
import { describe, expect, test } from 'vitest'

describe('codex', () => {
  test('连上的 server：tools 是 map，要数 key 不是数组长度', () => {
    // 实测 node_repl 的真实响应形状。
    const mapped = mapCodexMcpStatus({
      name: 'node_repl',
      serverInfo: { name: 'rmcp', title: null, version: '1.5.0', description: null },
      tools: { run: {}, eval: {}, reset: {} },
      resources: [],
      authStatus: 'unsupported',
    } as never)
    expect(mapped).toEqual<McpRuntimeStatus>({
      name: 'node_repl',
      state: 'connected',
      description: null,
      serverVersion: 'rmcp@1.5.0',
      toolCount: 3,
      authStatus: 'unsupported',
      error: null,
    })
  })

  test('serverInfo 为 null 时是 unknown，**不是** failed', () => {
    // 实测：`enabled = false` 的 computer-use 照样出现在列表里，serverInfo 为 null。
    // 映射成 failed 的话，用户会看到一个被自己关掉的 server 报「启动失败」。
    const mapped = mapCodexMcpStatus({
      name: 'computer-use',
      serverInfo: null,
      tools: {},
      resources: [],
      authStatus: 'unsupported',
    } as never)
    expect(mapped?.state).toBe('unknown')
    expect(mapped?.toolCount).toBe(0)
  })

  test('认得四种 authStatus，认不出的给 null 而不是原样透传', () => {
    for (const s of ['unsupported', 'notLoggedIn', 'bearerToken', 'oAuth']) {
      expect(mapCodexMcpStatus({ name: 'x', authStatus: s })?.authStatus).toBe(s)
    }
    expect(mapCodexMcpStatus({ name: 'x', authStatus: 'brandNew' })?.authStatus).toBeNull()
  })

  test('没有 name 的条目丢掉——名字是与配置侧对齐的唯一键', () => {
    expect(mapCodexMcpStatus({ serverInfo: null })).toBeNull()
  })

  test('只有 name 没有 version 时不拼出一个尾巴挂空的字符串', () => {
    expect(mapCodexMcpStatus({ name: 'x', serverInfo: { name: 'srv' } })?.serverVersion).toBe('srv')
  })
})

describe('codex 启动通知补状态', () => {
  const unknown = () => mapCodexMcpStatus({ name: 'x', serverInfo: null, tools: {} })!

  test('failed 通知把 unknown 补成 failed，并带出原文', () => {
    const out = applyCodexStartupState(unknown(), {
      status: 'failed',
      error: 'command not found: foo',
      needsAuth: false,
    })
    expect(out.state).toBe('failed')
    expect(out.error).toBe('command not found: foo')
  })

  test('reauthenticationRequired → needs-auth，不是 failed', () => {
    const out = applyCodexStartupState(unknown(), {
      status: 'failed',
      error: null,
      needsAuth: true,
    })
    expect(out.state).toBe('needs-auth')
  })

  test('cancelled 给一句人话，不留空的失败原因', () => {
    const out = applyCodexStartupState(unknown(), {
      status: 'cancelled',
      error: null,
      needsAuth: false,
    })
    expect(out.state).toBe('failed')
    expect(out.error).toBe('启动已取消')
  })

  test('列表说已连接时，旧的 failed 通知不能把它盖掉', () => {
    // 通知是攒下来的历史，列表里的 serverInfo 是"此刻连着"的直接证据。
    const connected = mapCodexMcpStatus({
      name: 'x',
      serverInfo: { name: 'srv', version: '1' },
      tools: { a: {} },
    })!
    const out = applyCodexStartupState(connected, {
      status: 'failed',
      error: 'stale',
      needsAuth: false,
    })
    expect(out.state).toBe('connected')
    expect(out.error).toBeNull()
  })

  test('没有通知就维持 unknown——不猜', () => {
    expect(applyCodexStartupState(unknown(), undefined).state).toBe('unknown')
  })
})

describe('claude', () => {
  test('五种状态各自归一', () => {
    const cases = [
      ['connected', 'connected'],
      ['failed', 'failed'],
      ['needs-auth', 'needs-auth'],
      ['disabled', 'disabled'],
      ['pending', 'connecting'],
    ] as const
    for (const [raw, expected] of cases) {
      expect(mapClaudeMcpStatus({ name: 'x', status: raw })?.state).toBe(expected)
    }
  })

  test('没见过的状态给 unknown，不猜', () => {
    expect(mapClaudeMcpStatus({ name: 'x', status: 'reconnecting' })?.state).toBe('unknown')
  })

  test('tools 是数组——与 codex 的 map 相反', () => {
    // 实测 chrome-devtools 连上后是 29 个工具的数组。
    const mapped = mapClaudeMcpStatus({
      name: 'chrome-devtools',
      status: 'connected',
      tools: Array.from({ length: 29 }, (_, i) => ({ name: `t${i}` })),
    })
    expect(mapped?.toolCount).toBe(29)
  })

  test('失败原文要带出来——只说「连不上」等于没说', () => {
    const mapped = mapClaudeMcpStatus({
      name: 'scorpio-mcp-server',
      status: 'failed',
      error: 'spawn ENOENT',
    })
    expect(mapped?.error).toBe('spawn ENOENT')
    expect(mapped?.state).toBe('failed')
  })

  test('claude 没有 authStatus / description，老实给 null', () => {
    const mapped = mapClaudeMcpStatus({ name: 'x', status: 'connected' })
    expect(mapped?.authStatus).toBeNull()
    expect(mapped?.description).toBeNull()
  })
})

function status(
  state: McpRuntimeStatus['state'],
  overrides: Partial<McpRuntimeStatus> = {},
): McpRuntimeStatus {
  return {
    name: 'x',
    state,
    description: null,
    serverVersion: null,
    toolCount: 0,
    authStatus: null,
    error: null,
    ...overrides,
  }
}

describe('attachRuntime', () => {
  function entry(name: string, visibleTo: BackendId[]): McpEntry {
    return {
      id: `global:${name}`,
      name,
      scope: 'global',
      folderPath: null,
      locations: [],
      visibleTo,
      injectedInto: [],
      managed: false,
      enabled: true,
      runtime: {},
    }
  }

  test('按名字挂上去，按后端分开', () => {
    const snapshot: McpSnapshot = { entries: [entry('a', ['codex', 'claude'])], issues: [] }
    attachRuntime(snapshot, {
      codex: [status('connected', { name: 'a', toolCount: 3 })],
      claude: [status('failed', { name: 'a', error: 'boom' })],
    })
    expect(snapshot.entries[0]?.runtime.codex?.state).toBe('connected')
    expect(snapshot.entries[0]?.runtime.claude?.error).toBe('boom')
  })

  test('该后端看不到的 server 不挂——名字撞车不该串台', () => {
    // 两个后端各配一个同名但完全不同的 server 并不罕见（github / filesystem 这种）。
    const snapshot: McpSnapshot = { entries: [entry('github', ['codex'])], issues: [] }
    attachRuntime(snapshot, { claude: [status('connected', { name: 'github', toolCount: 40 })] })
    expect(snapshot.entries[0]?.runtime.claude).toBeUndefined()
  })

  test('后端没回报的 server 保持空，不写一个假的「未连接」', () => {
    const snapshot: McpSnapshot = { entries: [entry('a', ['codex'])], issues: [] }
    attachRuntime(snapshot, { codex: [] })
    expect(snapshot.entries[0]?.runtime).toEqual({})
  })

  test('runtime 里不留 name 字段——它已经是 entry.name 了', () => {
    const snapshot: McpSnapshot = { entries: [entry('a', ['codex'])], issues: [] }
    attachRuntime(snapshot, { codex: [status('connected', { name: 'a' })] })
    expect(snapshot.entries[0]?.runtime.codex).not.toHaveProperty('name')
  })
})

describe('allSettled（claude 的轮询终止条件）', () => {
  test('还有 connecting 就继续等', () => {
    expect(allSettled([status('connected'), status('connecting')])).toBe(false)
  })

  test('全部落定（含 failed）就停', () => {
    expect(allSettled([status('connected'), status('failed')])).toBe(true)
  })

  test('空数组不算落定——刚握完手还没返回任何 server 时不能立刻收工', () => {
    expect(allSettled([])).toBe(false)
  })
})
