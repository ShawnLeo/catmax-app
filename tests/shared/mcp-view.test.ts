/**
 * Unified MCP Server Center: locations[] → 展示信息的派生规则。
 *
 * 这三条规则都不是显而易见的，而且每条都对应一个具体的"界面撒谎"：
 * 取错 location → 显示一份被覆盖的命令行；漂移判错 → 把 codex 正常的层覆盖
 * 报成两端不一致。
 */
import type { McpEntry, McpLocation, McpRootKind, McpServerConfig } from '@shared/mcp/types'
import { configSummary, hasCrossBackendDrift, pickDisplayLocation } from '@shared/mcp/view'
import { describe, expect, test } from 'vitest'

function loc(kind: McpRootKind, config: McpServerConfig): McpLocation {
  return {
    kind,
    address: 'x',
    filePath: '/tmp/x',
    nativeDisabled: false,
    ineffective: null,
    config,
    hasInlineSecret: false,
  }
}

function stdio(command: string, args: string[] = []): McpServerConfig {
  return { transport: 'stdio', command, args }
}

function entryOf(locations: McpLocation[]): McpEntry {
  return {
    id: 'global:x',
    name: 'x',
    scope: 'global',
    folderPath: null,
    locations,
    visibleTo: [],
    injectedInto: [],
    managed: false,
    enabled: true,
    runtime: {},
  }
}

describe('pickDisplayLocation', () => {
  test('优先取可写的那一层，而不是数组第一项', () => {
    // locations 按 MCP_ROOT_ORDER 升序，系统层排在用户层前面。取 [0] 会显示
    // `/opt/corp/mcp`——那是被用户层覆盖掉的，改它没有任何效果。
    const picked = pickDisplayLocation([
      loc('codex-system', stdio('/opt/corp/mcp')),
      loc('codex-user', stdio('/usr/local/bin/corp')),
    ])
    expect(picked?.kind).toBe('codex-user')
  })

  test('一处都不可写时退回第一项，而不是返回 null', () => {
    const picked = pickDisplayLocation([loc('claude-managed', stdio('/opt/corp'))])
    expect(picked?.kind).toBe('claude-managed')
  })

  test('空数组返回 null', () => {
    expect(pickDisplayLocation([])).toBeNull()
  })
})

describe('configSummary', () => {
  test('stdio 拼命令行', () => {
    expect(configSummary(loc('codex-user', stdio('npx', ['-y', 'pkg'])))).toBe('npx -y pkg')
  })

  test('远程取 URL', () => {
    expect(configSummary(loc('claude-user', { transport: 'http', url: 'https://x/mcp' }))).toBe(
      'https://x/mcp',
    )
  })

  test('没有 location 时给空串，不抛', () => {
    expect(configSummary(null)).toBe('')
  })
})

describe('hasCrossBackendDrift', () => {
  test('同一后端的层间差异不算漂移——那是 codex 配置栈的正常用法', () => {
    // 用户层就是用来覆盖系统层的，报成「两端不一致」是误报。
    expect(
      hasCrossBackendDrift(
        entryOf([
          loc('codex-system', stdio('/opt/corp/mcp')),
          loc('codex-user', stdio('/usr/local/bin/corp')),
        ]),
      ),
    ).toBe(false)
  })

  test('两个后端各自的生效配置不同才算漂移', () => {
    expect(
      hasCrossBackendDrift(
        entryOf([
          loc('codex-user', stdio('npx', ['-y', 'v2'])),
          loc('claude-user', stdio('npx', ['-y', 'v1'])),
        ]),
      ),
    ).toBe(true)
  })

  test('两端一致不报', () => {
    expect(
      hasCrossBackendDrift(
        entryOf([
          loc('codex-user', stdio('npx', ['-y', 'pkg'])),
          loc('claude-user', stdio('npx', ['-y', 'pkg'])),
        ]),
      ),
    ).toBe(false)
  })

  test('比的是各后端的可写层——codex 的用户层覆盖后与 claude 一致，就不该报漂移', () => {
    expect(
      hasCrossBackendDrift(
        entryOf([
          loc('codex-system', stdio('/opt/old')),
          loc('codex-user', stdio('npx', ['-y', 'pkg'])),
          loc('claude-user', stdio('npx', ['-y', 'pkg'])),
        ]),
      ),
    ).toBe(false)
  })
})
