// @vitest-environment node
/**
 * Unified MCP Server Center: 注入层的编码。
 *
 * 这组用例守的是一条比"功能对不对"更硬的线：**一个坏的 `-c` 会让 codex 整个起不来**，
 * 不是少一个 server。实测过的失败长这样：
 *
 *     Error: error loading default config after config error: invalid transport
 *     in `mcp_servers."my`
 *
 * 所以宁可拒绝注入，也不能赌它能解析。
 */
import { canInjectIntoCodex, codexInjectArgsFor } from '@main/service/mcp-inject'
import { describe, expect, test, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/catmax-inject-test' } }))

/** 把 ['-c', 'k=v', '-c', 'k2=v2'] 拍平成 'k=v' 的数组，断言好读。 */
function pairs(args: string[]): string[] {
  return args.filter((a) => a !== '-c')
}

describe('canInjectIntoCodex', () => {
  test('点号致命——`-c` 的 keyPath 解析器不认引号', () => {
    // 与 config/value/write 不同：那边 `mcp_servers."my.server".enabled` 是好的。
    expect(canInjectIntoCodex('my.server')).toBe(false)
  })

  test('实测能用的字符都放行', () => {
    // 这四种逐个真跑过 codex：都能正常起来。
    for (const name of ['plain', 'with-dash', 'with_underscore', 'with space', 'MixedCase9']) {
      expect(canInjectIntoCodex(name)).toBe(true)
    }
  })

  test('引号 / 反斜杠 / 等号一并拒掉', () => {
    // 没有实测（构造不出真实用例），但它们分别能破坏 TOML 字符串、转义和
    // key=value 的切分。保守的代价只是少一个可注入的 server。
    expect(canInjectIntoCodex('a"b')).toBe(false)
    expect(canInjectIntoCodex('a\\b')).toBe(false)
    expect(canInjectIntoCodex('a=b')).toBe(false)
  })
})

describe('codexInjectArgsFor', () => {
  test('stdio：命令 + 数组参数 + 内联表 env', () => {
    // 实测 `env={FOO="bar"}` 这种内联表能被 -c 正确解析成子表。
    const args = codexInjectArgsFor('weather', {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { FOO: 'bar' },
    })
    expect(pairs(args)).toEqual([
      'mcp_servers.weather.command="npx"',
      'mcp_servers.weather.args=["-y","pkg"]',
      'mcp_servers.weather.env={FOO="bar"}',
    ])
  })

  test('远程：url + http_headers', () => {
    const args = codexInjectArgsFor('remote', {
      transport: 'http',
      url: 'https://x/mcp',
      headers: { Authorization: 'Bearer t' },
    })
    expect(pairs(args)).toEqual([
      'mcp_servers.remote.url="https://x/mcp"',
      'mcp_servers.remote.http_headers={Authorization="Bearer t"}',
    ])
  })

  test('stdio 不带 url 字段，远程不带 command——两者同时给 codex 会报错', () => {
    const stdio = pairs(codexInjectArgsFor('x', { transport: 'stdio', command: 'a', url: 'u' }))
    expect(stdio.some((p) => p.includes('.url='))).toBe(false)
    const remote = pairs(codexInjectArgsFor('x', { transport: 'http', url: 'u', command: 'a' }))
    expect(remote.some((p) => p.includes('.command='))).toBe(false)
  })

  test('毫秒 → 秒向上取整：宁可多等，不能比用户设的更早超时', () => {
    const args = pairs(
      codexInjectArgsFor('x', { transport: 'stdio', command: 'a', startupTimeoutMs: 1500 }),
    )
    expect(args).toContain('mcp_servers.x.startup_timeout_sec=2')
  })

  test('引用式凭据原样带过去，不解析成明文', () => {
    // bearer_token_env_var 存的是变量名，codex 自己去环境里取。catmax 解析它
    // 就等于把密钥搬进了进程参数（ps 可见）。
    const args = pairs(
      codexInjectArgsFor('x', {
        transport: 'http',
        url: 'https://x/mcp',
        bearerTokenEnvVar: 'MY_TOKEN',
      }),
    )
    expect(args).toContain('mcp_servers.x.bearer_token_env_var="MY_TOKEN"')
  })

  test('字符串值走 JSON 转义——命令里带引号不会把 TOML 撕开', () => {
    const args = pairs(codexInjectArgsFor('x', { transport: 'stdio', command: 'say "hi"' }))
    expect(args).toEqual(['mcp_servers.x.command="say \\"hi\\""'])
  })

  test('空数组 / 空对象不产出参数——写个空的进去只是噪音', () => {
    const args = pairs(
      codexInjectArgsFor('x', { transport: 'stdio', command: 'a', args: [], env: {} }),
    )
    expect(args).toEqual(['mcp_servers.x.command="a"'])
  })
})
