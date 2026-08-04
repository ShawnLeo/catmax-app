// @vitest-environment node
/**
 * Unified MCP Server Center 的扫描与状态合并。
 *
 * 全部在临时 HOME 下跑：`codexUserConfigPath()` / `claudeJsonPath()` 最终都落到
 * `os.homedir()`，POSIX 下它读的就是 `$HOME`。不改 HOME 的话这个测试会去翻用户
 * 真实的 `~/.codex/config.toml` 和 `~/.claude.json`——既不可重现，也可能把别人
 * 的真实 MCP 配置读进断言里。
 *
 * 系统级的两个路径（`/etc/codex/config.toml`、`managed-mcp.json`）改不了 HOME，
 * 所以整体 mock 掉 mcp-roots 把它们重定向进临时目录——顺带切断了对真实机器的依赖：
 * 在装了企业配置的机器上跑，原本会把别人的真实 server 读进断言里。
 *
 * 断言一律按 **server 名**来找，不按数组下标或总数。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type * as McpRoots from '@main/service/mcp-roots'
import { MCP_SECRET_MASK, type McpEntry, type McpSnapshot } from '@shared/mcp/types'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ userDataDir: '', codexSystem: '', claudeManaged: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.userDataDir } }))

// 只改两个系统级路径，其余保持真实实现（尤其 claudeJsonPath 的 CLAUDE_CONFIG_DIR 规则
// 本身就是被测对象之一）。用 getter 是因为路径每个用例都不同，而 vi.mock 只跑一次。
vi.mock('@main/service/mcp-roots', async (importOriginal) => {
  const actual = await importOriginal<typeof McpRoots>()
  return {
    ...actual,
    get CODEX_SYSTEM_CONFIG() {
      return mocks.codexSystem
    },
    claudeManagedMcpPath: () => mocks.claudeManaged,
  }
})

const { scanMcpServers, isInsideFolder } = await import('@main/service/mcp-scanner')

let base = ''
let home = ''
let repo = ''
const saved: Record<string, string | undefined> = {}

function stashEnv(key: string, value?: string): void {
  saved[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function writeCodexUser(toml: string): void {
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex', 'config.toml'), toml)
}

function writeCodexProject(toml: string): void {
  mkdirSync(join(repo, '.codex'), { recursive: true })
  writeFileSync(join(repo, '.codex', 'config.toml'), toml)
}

function writeClaudeJson(obj: unknown): void {
  writeFileSync(join(home, '.claude.json'), JSON.stringify(obj, null, 2))
}

function writeCodexSystem(toml: string): void {
  writeFileSync(mocks.codexSystem, toml)
}

function writeClaudeManaged(obj: unknown): void {
  writeFileSync(mocks.claudeManaged, JSON.stringify(obj, null, 2))
}

function writeMcpJson(obj: unknown): void {
  writeFileSync(join(repo, '.mcp.json'), JSON.stringify(obj, null, 2))
}

function find(snapshot: McpSnapshot, id: string): McpEntry | undefined {
  return snapshot.entries.find((e) => e.id === id)
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'catmax-mcp-'))
  home = join(base, 'home')
  repo = join(base, 'repo')
  mocks.userDataDir = join(base, 'userData')
  // 默认指向不存在的文件——与"这台机器上没有企业配置"等价。
  mocks.codexSystem = join(base, 'etc-codex-config.toml')
  mocks.claudeManaged = join(base, 'managed-mcp.json')
  mkdirSync(home, { recursive: true })
  mkdirSync(repo, { recursive: true })
  mkdirSync(mocks.userDataDir, { recursive: true })
  stashEnv('HOME', home)
  // 这两个若从外部环境漏进来，会把扫描指到用户的真实配置目录。
  stashEnv('CODEX_HOME', undefined)
  stashEnv('CLAUDE_CONFIG_DIR', undefined)
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(base, { recursive: true, force: true })
})

describe('传输类型', () => {
  test('codex 的 url 段被识别为远程——它并非只支持 stdio', () => {
    // 这条钉的是设计文档 §0.1 推翻的第一个前提。codex 0.145 的 [mcp_servers.*]
    // 实测接受 url / bearer_token_env_var / http_headers / env_http_headers。
    writeCodexUser(`
[mcp_servers.remote]
url = "https://example.com/mcp"
bearer_token_env_var = "MY_TOKEN"
`)
    const entry = find(scanMcpServers(), 'global:remote')
    expect(entry?.locations[0]?.config.transport).toBe('http')
    expect(entry?.locations[0]?.config.url).toBe('https://example.com/mcp')
    expect(entry?.visibleTo).toEqual(['codex'])
  })

  test('claude 的 sse 与 http 分得开', () => {
    writeClaudeJson({
      mcpServers: {
        a: { type: 'sse', url: 'https://x/sse' },
        b: { type: 'http', url: 'https://x/mcp' },
      },
    })
    const snapshot = scanMcpServers()
    expect(find(snapshot, 'global:a')?.locations[0]?.config.transport).toBe('sse')
    expect(find(snapshot, 'global:b')?.locations[0]?.config.transport).toBe('http')
  })
})

describe('多来源合并', () => {
  test('两端同名 server 合成一条 entry，visibleTo 覆盖两个后端', () => {
    writeCodexUser(`
[mcp_servers.shared]
command = "npx"
args = ["-y", "pkg"]
`)
    writeClaudeJson({
      mcpServers: { shared: { type: 'stdio', command: 'npx', args: ['-y', 'pkg'] } },
    })
    const entry = find(scanMcpServers(), 'global:shared')
    expect(entry?.locations).toHaveLength(2)
    expect(entry?.visibleTo).toEqual(['claude', 'codex'])
    expect(entry?.locations.map((l) => l.kind)).toEqual(['codex-user', 'claude-user'])
  })

  test('系统层与用户层同名合成一条——用户层覆盖系统层，拆两条就会有一行是死的', () => {
    // codex 七层栈里 user 覆盖 system。若系统层单独占一个 scope，列表里会出现
    // 两行同名 server，其中系统层那行永远不生效，用户还会去改它。
    writeCodexSystem(`
[mcp_servers.corp]
command = "/opt/corp/mcp"
`)
    writeCodexUser(`
[mcp_servers.corp]
command = "/usr/local/bin/corp-mcp"
`)
    const snapshot = scanMcpServers()
    expect(snapshot.entries.filter((e) => e.name === 'corp')).toHaveLength(1)
    const entry = find(snapshot, 'global:corp')
    expect(entry?.locations.map((l) => l.kind)).toEqual(['codex-system', 'codex-user'])
  })

  test('全局与项目同名是两条独立记录，不合并', () => {
    writeClaudeJson({
      mcpServers: { dup: { command: 'global-one' } },
      projects: { [repo]: { mcpServers: { dup: { command: 'project-one' } } } },
    })
    const snapshot = scanMcpServers({ folderPaths: [repo] })
    expect(find(snapshot, 'global:dup')?.locations[0]?.config.command).toBe('global-one')
    expect(find(snapshot, 'project:dup')?.locations[0]?.config.command).toBe('project-one')
  })
})

describe('managed（写入路径的守卫）', () => {
  test('只有企业层定义时 managed = true', () => {
    writeClaudeManaged({ mcpServers: { corp: { type: 'stdio', command: '/opt/corp' } } })
    expect(find(scanMcpServers(), 'global:corp')?.managed).toBe(true)
  })

  test('用户层覆盖了同名项时 managed = false——判据是"一处也改不动"，不是"来自系统层"', () => {
    writeCodexSystem(`
[mcp_servers.corp]
command = "/opt/corp/mcp"
`)
    writeCodexUser(`
[mcp_servers.corp]
command = "/usr/local/bin/corp-mcp"
`)
    expect(find(scanMcpServers(), 'global:corp')?.managed).toBe(false)
  })

  test('普通用户配置 managed = false', () => {
    writeClaudeJson({ mcpServers: { weather: { type: 'stdio', command: 'npx' } } })
    expect(find(scanMcpServers(), 'global:weather')?.managed).toBe(false)
  })
})

describe('codex 项目层的 trust 门控', () => {
  test('未信任时标 needs-trust——配置在、列表里看得见，但 codex 实际不加载', () => {
    writeCodexUser('')
    writeCodexProject(`
[mcp_servers.proj]
command = "echo"
`)
    const entry = find(scanMcpServers({ folderPaths: [repo] }), 'project:proj')
    expect(entry?.locations[0]?.ineffective?.reason).toBe('needs-trust')
  })

  test('用户 config.toml 里 trust_level = "trusted" 后即生效', () => {
    writeCodexUser(`
[projects."${repo}"]
trust_level = "trusted"
`)
    writeCodexProject(`
[mcp_servers.proj]
command = "echo"
`)
    const entry = find(scanMcpServers({ folderPaths: [repo] }), 'project:proj')
    expect(entry?.locations[0]?.ineffective).toBeNull()
  })

  test('trust_level 是别的值时仍算不信任——这里必须保守', () => {
    writeCodexUser(`
[projects."${repo}"]
trust_level = "untrusted"
`)
    writeCodexProject(`
[mcp_servers.proj]
command = "echo"
`)
    const entry = find(scanMcpServers({ folderPaths: [repo] }), 'project:proj')
    expect(entry?.locations[0]?.ineffective?.reason).toBe('needs-trust')
  })
})

describe('claude 的开关与门控', () => {
  test('disabledMcpServers 关得掉一个定义在顶层的全局 server', () => {
    // 这条钉的是设计文档 §2.5：v1 认为顶层 server 无法禁用，实测是错的。
    // 本机的 scorpio-mcp-server 就是这么被某个项目关掉的。
    writeClaudeJson({
      mcpServers: { globalone: { command: 'x' } },
      projects: {
        [repo]: { disabledMcpServers: ['globalone'], mcpServers: { globalone: { command: 'x' } } },
      },
    })
    const entry = find(scanMcpServers({ folderPaths: [repo] }), 'project:globalone')
    expect(entry?.locations[0]?.nativeDisabled).toBe(true)
    expect(entry?.enabled).toBe(false)
  })

  test('.mcp.json 未被批准时标 needs-approval', () => {
    writeClaudeJson({ projects: { [repo]: {} } })
    writeMcpJson({ mcpServers: { shared: { command: 'x' } } })
    const entry = find(scanMcpServers({ folderPaths: [repo] }), 'project:shared')
    expect(entry?.locations[0]?.ineffective?.reason).toBe('needs-approval')
  })

  test('enabledMcpjsonServers 批准后生效', () => {
    writeClaudeJson({ projects: { [repo]: { enabledMcpjsonServers: ['shared'] } } })
    writeMcpJson({ mcpServers: { shared: { command: 'x' } } })
    const entry = find(scanMcpServers({ folderPaths: [repo] }), 'project:shared')
    expect(entry?.locations[0]?.ineffective).toBeNull()
  })

  test('enableAllProjectMcpServers 一次批准全部', () => {
    writeClaudeJson({ projects: { [repo]: { enableAllProjectMcpServers: true } } })
    writeMcpJson({ mcpServers: { a: { command: 'x' }, b: { command: 'y' } } })
    const snapshot = scanMcpServers({ folderPaths: [repo] })
    expect(find(snapshot, 'project:a')?.locations[0]?.ineffective).toBeNull()
    expect(find(snapshot, 'project:b')?.locations[0]?.ineffective).toBeNull()
  })

  test('disabledMcpjsonServers 优先于批准', () => {
    writeClaudeJson({
      projects: {
        [repo]: { enableAllProjectMcpServers: true, disabledMcpjsonServers: ['shared'] },
      },
    })
    writeMcpJson({ mcpServers: { shared: { command: 'x' } } })
    const entry = find(scanMcpServers({ folderPaths: [repo] }), 'project:shared')
    expect(entry?.locations[0]?.ineffective?.reason).toBe('needs-approval')
  })
})

describe('codex 原生 enabled', () => {
  test('enabled = false 让 entry 显示为关闭', () => {
    writeCodexUser(`
[mcp_servers.off]
command = "echo"
enabled = false
`)
    const entry = find(scanMcpServers(), 'global:off')
    expect(entry?.locations[0]?.nativeDisabled).toBe(true)
    expect(entry?.enabled).toBe(false)
  })

  test('缺省即启用', () => {
    writeCodexUser(`
[mcp_servers.on]
command = "echo"
`)
    expect(find(scanMcpServers(), 'global:on')?.enabled).toBe(true)
  })
})

describe('密钥脱敏（跨 IPC 的安全不变量）', () => {
  test('snapshot 里的明文 token 已被掩码，且打上 hasInlineSecret', () => {
    writeClaudeJson({
      mcpServers: {
        secretful: {
          type: 'http',
          url: 'https://x/mcp',
          headers: { Authorization: 'Bearer supersecrettokenvalue' },
        },
      },
    })
    const location = find(scanMcpServers(), 'global:secretful')?.locations[0]
    expect(location?.config.headers?.Authorization).toBe(MCP_SECRET_MASK)
    expect(location?.hasInlineSecret).toBe(true)
  })

  test('整份 snapshot 序列化后不含任何明文密钥', () => {
    // 端到端的兜底断言：McpSnapshot 是每次 list 都推给 renderer 的，
    // 只要有一条路径忘了脱敏，这里就会红。
    const token = 'sk-live-abcdefghijklmnopqrstuv'
    writeCodexUser(`
[mcp_servers.a]
command = "echo"

[mcp_servers.a.env]
OPENAI_API_KEY = "${token}"
`)
    writeClaudeJson({
      mcpServers: {
        b: { type: 'http', url: 'https://x/mcp', headers: { Authorization: `Bearer ${token}` } },
      },
    })
    const serialized = JSON.stringify(scanMcpServers({ folderPaths: [repo] }))
    expect(serialized).not.toContain(token)
  })
})

describe('容错', () => {
  test('坏掉的 TOML 记 issue 而不是让整张列表打不开', () => {
    writeCodexUser('this is not valid toml [[[')
    writeClaudeJson({ mcpServers: { fine: { command: 'x' } } })
    const snapshot = scanMcpServers()
    expect(snapshot.issues.some((i) => i.path.endsWith('config.toml'))).toBe(true)
    // 另一个后端的 server 照常扫出来
    expect(find(snapshot, 'global:fine')).toBeDefined()
  })

  test('坏掉的 JSON 同样只记 issue', () => {
    writeFileSync(join(home, '.claude.json'), '{ not json')
    writeCodexUser(`
[mcp_servers.fine]
command = "x"
`)
    const snapshot = scanMcpServers()
    expect(snapshot.issues.some((i) => i.path.endsWith('.claude.json'))).toBe(true)
    expect(find(snapshot, 'global:fine')).toBeDefined()
  })

  test('配置文件都不存在时返回空列表而不是抛', () => {
    expect(() => scanMcpServers()).not.toThrow()
  })
})

describe('isInsideFolder', () => {
  test('前缀相同但不是子目录要判掉', () => {
    expect(isInsideFolder('/a/foo/x.json', '/a/foo')).toBe(true)
    expect(isInsideFolder('/a/foo', '/a/foo')).toBe(true)
    expect(isInsideFolder('/a/foo-bar/x.json', '/a/foo')).toBe(false)
  })
})
