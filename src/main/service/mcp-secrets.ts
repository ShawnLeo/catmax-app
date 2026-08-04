/**
 * Unified MCP Server Center: 密钥识别与脱敏。
 *
 * 为什么这个文件必须与扫描器同期存在、不能后补：
 * MCP 配置里 routinely 含明文密钥——本机 `~/.claude.json` 的 web-search-prime 就是
 * `headers: { Authorization: "Bearer <token>" }`。而 `McpSnapshot` 是**每次 list 都往
 * renderer 推的**，一旦不脱敏，密钥立刻进入 Vue devtools、日志、错误上报的每一条路径。
 *
 * 这与 Protocol Bridge 那条既定边界是同一条：密钥只 renderer → main 单向，IPC 只回
 * 布尔（那边是 `credentialReady`，这里是 `hasInlineSecret`），值永远不出 main。
 *
 * 判定策略是**保守的**：宁可把非密钥也标成密钥（多打一次码，用户体验略糙），
 * 也不能漏掉一个真密钥（凭据外流，不可逆）。所以 key 名与值形状任一命中即算。
 */
import { MCP_SECRET_MASK, type McpServerConfig } from '@shared/mcp/types'

/**
 * 按 key 名判定。命中即当密钥，不看值。
 *
 * `token` 要匹配 `bearer_token` / `access_token` 这类带前后缀的；`key` 单独放宽会
 * 误伤（比如 `pubkey`），但漏判的代价远大于误判，所以照样收。
 */
const SECRET_KEY_PATTERN =
  /(authorization|auth|token|secret|password|passwd|credential|api[-_]?key|access[-_]?key|private[-_]?key|session[-_]?id|cookie|bearer|sig|signature)/i

/**
 * 按值形状判定，兜住 key 名起得很怪的情况（`X-Custom-Thing: sk-live-...`）。
 *
 * 三类：常见供应商前缀（sk-/ghp_/xoxb- 等）、显式 Bearer/Basic、以及「长且高熵的
 * 无空格串」。最后一条的阈值取 24——短于它的多半是 id 或版本号而不是凭据。
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^(bearer|basic|token)\s+\S+/i,
  /\b(sk|pk|rk|ak)-[A-Za-z0-9_-]{12,}/,
  /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /^[A-Za-z0-9_\-.]{24,}$/,
]

function looksLikeSecretValue(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '') return false
  return SECRET_VALUE_PATTERNS.some((re) => re.test(trimmed))
}

/** 一个 key/value 对是不是密钥。key 名或值形状任一命中即算（保守方向）。 */
export function isSecretPair(key: string, value: string): boolean {
  if (SECRET_KEY_PATTERN.test(key)) return true
  return looksLikeSecretValue(value)
}

/**
 * 这份配置里有没有明文密钥。
 *
 * 只看 `headers` 和 `env` 两处——它们存的是**值**。`bearerTokenEnvVar` 和
 * `headerEnvRefs` 存的是**环境变量名**（codex 的引用式写法），那不是密钥本身，
 * 恰恰是我们想推荐用户改用的更安全形态，不该被标成风险。
 */
export function hasInlineSecret(config: McpServerConfig): boolean {
  for (const [k, v] of Object.entries(config.headers ?? {})) {
    if (typeof v === 'string' && isSecretPair(k, v)) return true
  }
  for (const [k, v] of Object.entries(config.env ?? {})) {
    if (typeof v === 'string' && isSecretPair(k, v)) return true
  }
  return false
}

function redactRecord(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(record)) {
    out[k] = typeof v === 'string' && isSecretPair(k, v) ? MCP_SECRET_MASK : v
  }
  return out
}

/**
 * 生成一份可以安全跨 IPC 的配置副本。
 *
 * **保留 key 名、只替换值**——用户需要看见「这个 server 配了 Authorization 头」
 * 才能判断配置对不对，掩掉 key 名等于把列表变成瞎子。
 *
 * 注意这是**新对象**，不改原配置：main 侧的写入/同步路径仍要用未脱敏的原件，
 * 两者不能是同一个引用，否则一次脱敏会把真配置也毁掉。
 */
export function redactConfig(config: McpServerConfig): McpServerConfig {
  // 逐个赋值而不是 `{ ...config, headers: redact(...) }`：tsconfig 开了
  // exactOptionalPropertyTypes，把 undefined 显式写进可选属性是类型错误，而且
  // 会让 `'headers' in config` 从 false 变成 true——那是语义变化，不只是类型噪音。
  const out: McpServerConfig = { ...config }
  if (config.headers) out.headers = redactRecord(config.headers)
  if (config.env) out.env = redactRecord(config.env)
  return out
}
