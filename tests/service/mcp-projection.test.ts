// @vitest-environment node
/**
 * Unified MCP Server Center: 开关投影的两条易错规则。
 *
 * 都是实测撞出来的，不是照类型推的：codex 的 keyPath 转义错了会**先写坏再报错**，
 * 写入目标选错了会以一个跟原因毫无关系的 `invalid transport` 失败。
 */
import { codexMcpKeyPath, codexTrustKeyPath } from '@main/service/mcp-config-codec'
import { codexWriteTarget } from '@main/service/mcp-projection'
import type { McpEntry, McpLocation, McpRootKind } from '@shared/mcp/types'
import { describe, expect, test } from 'vitest'

function loc(kind: McpRootKind, filePath: string | null): McpLocation {
  return {
    kind,
    address: 'x',
    filePath,
    nativeDisabled: false,
    ineffective: null,
    config: { transport: 'stdio', command: 'x' },
    hasInlineSecret: false,
  }
}

function entryOf(locations: McpLocation[]): McpEntry {
  return {
    id: 'global:x',
    name: 'x',
    scope: 'global',
    folderPath: null,
    locations,
    visibleTo: ['codex'],
    injectedInto: [],
    managed: false,
    enabled: true,
    runtime: {},
  }
}

describe('codex keyPath 转义', () => {
  test('server 名一律加引号', () => {
    // 实测：不加引号时 `mcp_servers.my.server.enabled` 被当成三层嵌套表，
    // 去写一个 [mcp_servers.my.server] 新段，然后配置校验报
    // `invalid transport in mcp_servers.my`——是先写坏再报错，不是拒绝。
    expect(codexMcpKeyPath('my.server', 'enabled')).toBe('mcp_servers."my.server".enabled')
    expect(codexMcpKeyPath('web-search-prime', 'enabled')).toBe(
      'mcp_servers."web-search-prime".enabled',
    )
  })

  test('名字里的引号和反斜杠要转义，否则拼出来的 keyPath 直接是坏的', () => {
    expect(codexMcpKeyPath('a"b', 'enabled')).toBe('mcp_servers."a\\"b".enabled')
    expect(codexMcpKeyPath('a\\b', 'enabled')).toBe('mcp_servers."a\\\\b".enabled')
  })

  test('项目路径同样加引号——路径几乎必然带点或空格', () => {
    expect(codexTrustKeyPath('/Users/x/my.project')).toBe(
      'projects."/Users/x/my.project".trust_level',
    )
    expect(codexTrustKeyPath('/Users/x/some repo')).toBe(
      'projects."/Users/x/some repo".trust_level',
    )
  })
})

describe('codexWriteTarget', () => {
  test('写回 server 真正定义在的那个文件', () => {
    // codex 写入时校验整份配置：往一个没有该 server 定义的文件里写 enabled 会以
    // `invalid transport` 失败（光有 enabled 既没 command 也没 url）。
    expect(codexWriteTarget(entryOf([loc('codex-project', '/repo/.codex/config.toml')]))).toBe(
      '/repo/.codex/config.toml',
    )
  })

  test('系统层不可写，要跳到用户层', () => {
    expect(
      codexWriteTarget(
        entryOf([
          loc('codex-system', '/etc/codex/config.toml'),
          loc('codex-user', '/h/config.toml'),
        ]),
      ),
    ).toBe('/h/config.toml')
  })

  test('只有系统层定义时返回 null——不许退回去猜用户 config.toml', () => {
    // 猜的话会往用户配置里写一个只有 enabled 的段，codex 直接判非法。
    expect(codexWriteTarget(entryOf([loc('codex-system', '/etc/codex/config.toml')]))).toBeNull()
  })

  test('claude 侧的 location 不算——那不是 codex 能读的文件', () => {
    expect(codexWriteTarget(entryOf([loc('claude-user', '/h/.claude.json')]))).toBeNull()
  })
})
