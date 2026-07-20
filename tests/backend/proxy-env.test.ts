// @vitest-environment node
/**
 * proxy-env helper 测试：把 settings.httpProxy 转成 spawn env。
 */

import { parseSystemProxy, proxySettingsToEnv } from '@main/backend/proxy-env'
import type { HttpProxy } from '@shared/settings-schema'
import { describe, expect, test } from 'vitest'

describe('proxySettingsToEnv', () => {
  test('enabled=false 时返回空对象（不影响子进程）', () => {
    const proxy: HttpProxy = { enabled: false, url: 'http://127.0.0.1:7890', bypass: null }
    expect(proxySettingsToEnv(proxy)).toEqual({})
  })

  test('url 为空时返回空对象', () => {
    const proxy: HttpProxy = { enabled: true, url: null, bypass: null }
    expect(proxySettingsToEnv(proxy)).toEqual({})
  })

  test('正常代理 → 同时设大小写两套变量', () => {
    const proxy: HttpProxy = { enabled: true, url: 'http://127.0.0.1:7890', bypass: null }
    const env = proxySettingsToEnv(proxy)
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7890')
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(env.http_proxy).toBe('http://127.0.0.1:7890')
    expect(env.https_proxy).toBe('http://127.0.0.1:7890')
    expect(env.ALL_PROXY).toBe('http://127.0.0.1:7890')
    expect(env.all_proxy).toBe('http://127.0.0.1:7890')
  })

  test('用户填 "127.0.0.1:7890" 不带 scheme → 自动补 http://', () => {
    const proxy: HttpProxy = { enabled: true, url: '127.0.0.1:7890', bypass: null }
    expect(proxySettingsToEnv(proxy).HTTPS_PROXY).toBe('http://127.0.0.1:7890')
  })

  test('带 bypass → 同时设 NO_PROXY / no_proxy', () => {
    const proxy: HttpProxy = {
      enabled: true,
      url: 'http://127.0.0.1:7890',
      bypass: 'localhost,internal.corp',
    }
    const env = proxySettingsToEnv(proxy)
    expect(env.NO_PROXY).toBe('localhost,internal.corp')
    expect(env.no_proxy).toBe('localhost,internal.corp')
  })

  test('bypass 为空字符串时不设 NO_PROXY', () => {
    const proxy: HttpProxy = { enabled: true, url: 'http://127.0.0.1:7890', bypass: '' }
    const env = proxySettingsToEnv(proxy)
    expect(env.NO_PROXY).toBeUndefined()
  })

  test('socks5 代理也支持', () => {
    const proxy: HttpProxy = { enabled: true, url: 'socks5://127.0.0.1:1080', bypass: null }
    expect(proxySettingsToEnv(proxy).ALL_PROXY).toBe('socks5://127.0.0.1:1080')
  })
})

describe('parseSystemProxy (macOS scutil)', () => {
  // 模拟 scutil --proxy 输出
  const scutilOutput = `<dictionary> {
  ExceptionsList : <array> {
    0 : 192.168.0.0/16
    1 : 10.0.0.0/8
    2 : 127.0.0.1
    3 : localhost
    4 : *.local
    5 : timestamp.apple.com
  }
  ExcludeSimpleHostnames : 0
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
}`

  test('检测到启用的代理 → 返回 url', () => {
    const result = parseSystemProxy(scutilOutput)
    expect(result).not.toBeNull()
    expect(result!.enabled).toBe(true)
    expect(result!.url).toBe('http://127.0.0.1:7890')
    // bypass 可能被过滤成 null（如果 ExceptionsList 全是本地网络/Apple 域名）
    // 这里测试输入恰好全部该过滤——bypass 应该为 null
    expect(result!.bypass).toBeNull()
  })

  test('bypass 含用户自定义域名时保留', () => {
    const customInput = scutilOutput.replace(
      '5 : timestamp.apple.com',
      '5 : timestamp.apple.com\n    6 : internal.corp\n    7 : 10.20.30.40',
    )
    const result = parseSystemProxy(customInput)
    expect(result!.bypass).toContain('internal.corp')
    expect(result!.bypass).toContain('10.20.30.40')
    // 但 apple.com 和 192.168.0.0/16 仍然被过滤
    expect(result!.bypass).not.toContain('apple.com')
    expect(result!.bypass).not.toContain('192.168')
  })

  test('过滤掉本地网络段和 apple 域名（用户调 OpenAI 不需要绕过这些）', () => {
    const result = parseSystemProxy(scutilOutput)
    // 192.168.0.0/16 / 10.0.0.0/8 / 127.0.0.1 / localhost / *.local / *.apple.com 都应被过滤
    const bypass = result!.bypass ?? ''
    expect(bypass).not.toContain('192.168')
    expect(bypass).not.toContain('127.0.0.1')
    expect(bypass).not.toContain('localhost')
    expect(bypass).not.toContain('*.local')
    expect(bypass).not.toContain('apple.com')
  })

  test('代理禁用 → 返回 null', () => {
    const disabled = scutilOutput
      .replace('HTTPEnable : 1', 'HTTPEnable : 0')
      .replace('HTTPSEnable : 1', 'HTTPSEnable : 0')
    expect(parseSystemProxy(disabled)).toBeNull()
  })

  test('只有 HTTP 启用也能检测到', () => {
    const httpOnly = scutilOutput.replace('HTTPSEnable : 1', 'HTTPSEnable : 0')
    const result = parseSystemProxy(httpOnly)
    expect(result).not.toBeNull()
    expect(result!.url).toBe('http://127.0.0.1:7890')
  })
})
