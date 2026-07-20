/**
 * 把 settings.httpProxy 转成 spawn 子进程用的环境变量。
 *
 * 子进程（codex / claude CLI）通过这些环境变量识别代理：
 *   HTTPS_PROXY / https_proxy  - HTTPS 请求走代理（codex 调 OpenAI API 用这个）
 *   HTTP_PROXY  / http_proxy   - HTTP 请求走代理
 *   NO_PROXY    / no_proxy     - 不走代理的域名（bypass 列表）
 *
 * 大多数 CLI 工具（reqwest/curl/axios/node-fetch）都遵循这些约定。
 */
import type { HttpProxy } from '@shared/settings-schema'

/**
 * 把 HttpProxy settings 转成 env 键值对。
 * - enabled = false 或 url 为空时返回空对象（不修改环境）
 * - 否则同时设大小写两套变量（不同工具读不同的）
 */
export function proxySettingsToEnv(proxy: HttpProxy | null | undefined): Record<string, string> {
  if (!proxy || !proxy.enabled || !proxy.url) {
    return {}
  }

  // 规范化 URL：补全 scheme（用户可能只填了 127.0.0.1:7890）
  let url = proxy.url.trim()
  // 已经带 scheme（http/https/socks5/socks4 等）的不补
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    url = `http://${url}`
  }

  const env: Record<string, string> = {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    // Codex CLI (reqwest) 用 ALL_PROXY 作为兜底，配上有备无患
    ALL_PROXY: url,
    all_proxy: url,
  }

  if (proxy.bypass) {
    // NO_PROXY 是逗号分隔域名列表，用户 settings 里也按这个格式存
    const bypass = proxy.bypass.trim()
    if (bypass) {
      env.NO_PROXY = bypass
      env.no_proxy = bypass
    }
  }

  return env
}

/**
 * 把 macOS 系统代理（scutil --proxy 输出）解析成 HttpProxy settings。
 * 用于"一键检测系统代理"按钮。
 *
 * 返回 null 表示系统没启用代理。
 */
export function parseSystemProxy(scutilOutput: string): {
  enabled: boolean
  url: string
  bypass: string | null
} | null {
  // 解析 key : value 形式（scutil --proxy 输出）
  const get = (key: string): string | null => {
    const m = scutilOutput.match(new RegExp(`${key}\\s*:\\s*(\\S+)`))
    return m ? m[1]! : null
  }

  const httpsEnable = get('HTTPSEnable') === '1'
  const httpEnable = get('HTTPEnable') === '1'
  const host = get('HTTPSProxy') ?? get('HTTPProxy')
  const port = get('HTTPSPort') ?? get('HTTPPort')

  if ((!httpsEnable && !httpEnable) || !host || !port) {
    return null
  }

  // bypass 列表（ExceptionsList 数组）
  const bypassMatches = Array.from(scutilOutput.matchAll(/^\s*(\d+)\s*:\s*(.+)$/gm))
  const bypassList = bypassMatches.map((m) => m[2]!.trim())
  // 系统默认会带一些本地网络段，过滤掉对外部 API 没意义的：
  // - 私有网段：192.168/10./172.16-12./127.0.0.1
  // - localhost / *.local
  // - apple.com 系列
  const meaningful = bypassList.filter((s) => {
    if (
      s.match(/^(192\.168\.\d+\.\d+\/\d+|10\.\d+\.\d+\.\d+\/\d+|172\.\d+\.\d+\.\d+\/\d+)$/)
    ) return false
    if (s === '127.0.0.1' || s.startsWith('127.')) return false
    if (s === 'localhost') return false
    if (s.endsWith('.local') || s === '*.local') return false
    if (s.endsWith('.apple.com') || s.includes('apple.com')) return false
    return true
  })

  return {
    enabled: true,
    url: `http://${host}:${port}`,
    bypass: meaningful.length > 0 ? meaningful.join(',') : null,
  }
}
