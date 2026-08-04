/**
 * Unified MCP Server Center: 密钥脱敏。
 *
 * 这组用例守的是一条**不可逆的安全不变量**：McpSnapshot 每次 list 都推给 renderer，
 * 漏一个明文密钥就等于把它送进 devtools / 日志 / 错误上报。所以判定必须保守——
 * 宁可多打一次码，不可漏掉一个。下面的用例故意包含"误判也可接受"的例子。
 */
import { hasInlineSecret, isSecretPair, redactConfig } from '@main/service/mcp-secrets'
import { MCP_SECRET_MASK, type McpServerConfig } from '@shared/mcp/types'
import { describe, expect, it } from 'vitest'

describe('密钥识别', () => {
  it('按 key 名命中', () => {
    expect(isSecretPair('Authorization', 'anything')).toBe(true)
    expect(isSecretPair('api_key', 'x')).toBe(true)
    expect(isSecretPair('API-KEY', 'x')).toBe(true)
    expect(isSecretPair('MY_SECRET', 'x')).toBe(true)
    expect(isSecretPair('password', 'x')).toBe(true)
  })

  it('按值形状命中，兜住 key 名起得很怪的情况', () => {
    expect(isSecretPair('X-Custom', 'Bearer abc123')).toBe(true)
    expect(isSecretPair('X-Custom', 'sk-live-abcdefghijklmnop')).toBe(true)
    expect(isSecretPair('X-Custom', 'ghp_abcdefghijklmnopqrstuvwxyz01')).toBe(true)
    // 长且高熵的无空格串——本机 web-search-prime 的 token 就是这个形状
    expect(isSecretPair('X-Custom', '506195c78d58415ba05d93b6059dfa9c.Hh6y0i1mSOuRfUbB')).toBe(true)
  })

  it('普通配置值不误判', () => {
    expect(isSecretPair('X-Client', 'catmax')).toBe(false)
    expect(isSecretPair('Accept', 'application/json')).toBe(false)
    expect(isSecretPair('NODE_ENV', 'production')).toBe(false)
    expect(isSecretPair('CODEX_HOME', '/Users/x/.codex')).toBe(false)
  })

  it('空值不算密钥', () => {
    expect(isSecretPair('X-Custom', '')).toBe(false)
    expect(isSecretPair('X-Custom', '   ')).toBe(false)
  })
})

describe('hasInlineSecret', () => {
  it('headers 里的明文 token 会被认出来', () => {
    expect(
      hasInlineSecret({
        transport: 'http',
        url: 'https://x/mcp',
        headers: { Authorization: 'Bearer t' },
      }),
    ).toBe(true)
  })

  it('env 里的 API key 会被认出来', () => {
    expect(
      hasInlineSecret({ transport: 'stdio', command: 'x', env: { OPENAI_API_KEY: 'sk-abc' } }),
    ).toBe(true)
  })

  it('引用式凭据**不算**明文密钥——那正是我们想推荐的更安全形态', () => {
    expect(
      hasInlineSecret({ transport: 'http', url: 'https://x/mcp', bearerTokenEnvVar: 'MY_TOKEN' }),
    ).toBe(false)
    expect(
      hasInlineSecret({
        transport: 'http',
        url: 'https://x/mcp',
        headerEnvRefs: { Authorization: 'MY_TOKEN' },
      }),
    ).toBe(false)
  })

  it('干净配置返回 false', () => {
    expect(hasInlineSecret({ transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] })).toBe(false)
  })
})

describe('redactConfig', () => {
  it('掩掉值但保留 key 名——用户要能看见"配了 Authorization 头"才判断得了对错', () => {
    const out = redactConfig({
      transport: 'http',
      url: 'https://x/mcp',
      headers: { Authorization: 'Bearer supersecret', Accept: 'application/json' },
    })
    expect(out.headers).toEqual({ Authorization: MCP_SECRET_MASK, Accept: 'application/json' })
    // 非密钥字段原样保留，否则列表就成了瞎子
    expect(out.url).toBe('https://x/mcp')
  })

  it('env 同样处理', () => {
    const out = redactConfig({
      transport: 'stdio',
      command: 'x',
      env: { OPENAI_API_KEY: 'sk-abcdefghijklmnop', NODE_ENV: 'production' },
    })
    expect(out.env).toEqual({ OPENAI_API_KEY: MCP_SECRET_MASK, NODE_ENV: 'production' })
  })

  it('不改原对象——main 侧的写入路径还要用未脱敏的原件', () => {
    const original: McpServerConfig = {
      transport: 'http',
      url: 'https://x/mcp',
      headers: { Authorization: 'Bearer supersecret' },
    }
    redactConfig(original)
    expect(original.headers?.Authorization).toBe('Bearer supersecret')
  })

  it('没有 headers/env 时不会凭空造出这两个 key', () => {
    const out = redactConfig({ transport: 'stdio', command: 'x' })
    expect('headers' in out).toBe(false)
    expect('env' in out).toBe(false)
  })
})
