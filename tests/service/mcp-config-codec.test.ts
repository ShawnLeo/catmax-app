/**
 * Unified MCP Server Center: codec 的字段映射与有损分析。
 *
 * 这些用例钉的是**实测结论**，不是想当然的对称性。改动前先回去看设计文档 §2.1 的
 * 字段表——那张表是逐字段跑 `codex app-server --strict-config` 得到的，改 codec 之前
 * 若没有新的探针数据，就不该改这里的期望值。
 */
import {
  describeLoss,
  parseClaudeServer,
  parseCodexEnabled,
  parseCodexServer,
  serializeClaudeServer,
  serializeCodexServer,
} from '@main/service/mcp-config-codec'
import type { McpServerConfig } from '@shared/mcp/types'
import { describe, expect, it } from 'vitest'

describe('codex 解析', () => {
  it('有 command 即 stdio，env 子表并入', () => {
    const config = parseCodexServer({
      command: '/bin/node_repl',
      args: ['--foo'],
      cwd: '.',
      env: { CODEX_HOME: '/home/x' },
      startup_timeout_sec: 120,
      tool_timeout_sec: 30,
    })
    expect(config.transport).toBe('stdio')
    expect(config.command).toBe('/bin/node_repl')
    expect(config.cwd).toBe('.')
    expect(config.env).toEqual({ CODEX_HOME: '/home/x' })
    // 两个超时是**独立**字段，不能合并——codex 有 startup 和 tool 两个，claude 只有一个。
    expect(config.startupTimeoutMs).toBe(120_000)
    expect(config.toolTimeoutMs).toBe(30_000)
  })

  it('有 url 即远程；codex 没有 type 字段所以只能记成 http', () => {
    const config = parseCodexServer({
      url: 'https://example.com/mcp',
      bearer_token_env_var: 'MY_TOKEN',
      http_headers: { 'X-A': 'b' },
      env_http_headers: { 'X-B': 'ENV_B' },
    })
    expect(config.transport).toBe('http')
    expect(config.url).toBe('https://example.com/mcp')
    // 引用式凭据保留成"环境变量名"，不去解析它的值——这正是它比明文更安全的地方。
    expect(config.bearerTokenEnvVar).toBe('MY_TOKEN')
    expect(config.headers).toEqual({ 'X-A': 'b' })
    expect(config.headerEnvRefs).toEqual({ 'X-B': 'ENV_B' })
  })

  it('enabled 缺省为 true，只有显式 false 才算禁用', () => {
    expect(parseCodexEnabled({ command: 'x' })).toBe(true)
    expect(parseCodexEnabled({ command: 'x', enabled: true })).toBe(true)
    expect(parseCodexEnabled({ command: 'x', enabled: false })).toBe(false)
  })
})

describe('codex 序列化', () => {
  it('stdio 往返幂等', () => {
    const original: McpServerConfig = {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { A: 'b' },
      cwd: '/tmp',
      startupTimeoutMs: 10_000,
    }
    expect(parseCodexServer(serializeCodexServer(original, true))).toEqual(original)
  })

  it('远程往返幂等', () => {
    const original: McpServerConfig = {
      transport: 'http',
      url: 'https://x/mcp',
      headers: { 'X-A': 'b' },
      bearerTokenEnvVar: 'T',
    }
    expect(parseCodexServer(serializeCodexServer(original, true))).toEqual(original)
  })

  it('启用时不写 enabled 字段——codex 缺省就是 true，写上去只会让 config.toml 变吵', () => {
    expect(serializeCodexServer({ transport: 'stdio', command: 'x' }, true).enabled).toBeUndefined()
    expect(serializeCodexServer({ transport: 'stdio', command: 'x' }, false).enabled).toBe(false)
  })

  it('毫秒→秒向上取整（codex 只接受整秒）', () => {
    const out = serializeCodexServer(
      { transport: 'stdio', command: 'x', startupTimeoutMs: 1500 },
      true,
    )
    expect(out.startup_timeout_sec).toBe(2)
  })

  it('绝不输出 codex 不认识的字段——多写一个就会让 --strict-config 拒绝启动', () => {
    const out = serializeCodexServer(
      { transport: 'stdio', command: 'x', alwaysLoad: true },
      true,
    ) as Record<string, unknown>
    expect(out.alwaysLoad).toBeUndefined()
    expect(out.type).toBeUndefined()
    expect(out.transport).toBeUndefined()
    expect(out.description).toBeUndefined()
  })

  it('远程配置不会同时写出 command——codex 会报 "url is not supported for stdio"', () => {
    const out = serializeCodexServer(
      { transport: 'http', url: 'https://x/mcp', command: 'leftover' },
      true,
    )
    expect(out.url).toBe('https://x/mcp')
    expect(out.command).toBeUndefined()
  })
})

describe('claude 解析', () => {
  it('type 可省略，缺省 stdio', () => {
    expect(parseClaudeServer({ command: 'npx', args: ['-y', 'x'] }).transport).toBe('stdio')
  })

  it('省略 type 但有 url 时按远程处理', () => {
    expect(parseClaudeServer({ url: 'https://x/mcp' }).transport).toBe('http')
  })

  it('sse 与 http 是不同的 transport（这正是 codex 表达不了的东西）', () => {
    expect(parseClaudeServer({ type: 'sse', url: 'https://x/sse' }).transport).toBe('sse')
    expect(parseClaudeServer({ type: 'http', url: 'https://x/mcp' }).transport).toBe('http')
  })

  it('timeout 是毫秒，直接用', () => {
    expect(parseClaudeServer({ command: 'x', timeout: 1500 }).startupTimeoutMs).toBe(1500)
  })

  it('往返幂等', () => {
    const original: McpServerConfig = {
      transport: 'sse',
      url: 'https://x/sse',
      headers: { Authorization: 'Bearer t' },
      enabledTools: ['a'],
      startupTimeoutMs: 1500,
      alwaysLoad: true,
    }
    expect(parseClaudeServer(serializeClaudeServer(original))).toEqual(original)
  })
})

describe('有损分析', () => {
  it('sse → codex 是 blocking：codex 没有传输类型字段，会塌缩成 http', () => {
    const loss = describeLoss({ transport: 'sse', url: 'https://x/sse' }, 'codex')
    const collapse = loss.find((l) => l.kind === 'transport-collapse')
    expect(collapse?.blocking).toBe(true)
  })

  it('http → codex 无塌缩问题', () => {
    const loss = describeLoss({ transport: 'http', url: 'https://x/mcp' }, 'codex')
    expect(loss.some((l) => l.kind === 'transport-collapse')).toBe(false)
  })

  it('stdio 双向是干净的（除了 cwd）', () => {
    expect(describeLoss({ transport: 'stdio', command: 'x' }, 'codex')).toEqual([])
    expect(describeLoss({ transport: 'stdio', command: 'x' }, 'claude')).toEqual([])
  })

  it('cwd / toolTimeout 到 claude 是非 blocking 的丢弃', () => {
    const loss = describeLoss(
      { transport: 'stdio', command: 'x', cwd: '/tmp', toolTimeoutMs: 5000 },
      'claude',
    )
    expect(loss).toHaveLength(2)
    expect(loss.every((l) => l.kind === 'dropped-field' && !l.blocking)).toBe(true)
  })

  it('引用式凭据 → claude 是 blocking：绝不自动把环境变量物化成明文落盘', () => {
    const loss = describeLoss(
      { transport: 'http', url: 'https://x/mcp', bearerTokenEnvVar: 'T' },
      'claude',
    )
    const materialize = loss.find((l) => l.kind === 'secret-materialization')
    expect(materialize?.blocking).toBe(true)
  })

  it('env_http_headers → claude 同样 blocking', () => {
    const loss = describeLoss(
      { transport: 'http', url: 'https://x/mcp', headerEnvRefs: { 'X-A': 'ENV_A' } },
      'claude',
    )
    expect(loss.some((l) => l.kind === 'secret-materialization' && l.blocking)).toBe(true)
  })

  it('明文 headers → codex 不算 blocking：暴露面与源相同，没有变差', () => {
    const loss = describeLoss(
      { transport: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } },
      'codex',
    )
    expect(loss.some((l) => l.blocking)).toBe(false)
  })
})
