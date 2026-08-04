/**
 * Unified MCP Server Center: 各后端配置格式 ↔ McpServerConfig 的互转。
 * **全部纯函数、零 IO**，往返幂等是这个文件的主要单测形态。
 *
 * 字段表全部来自逐字段实测（`codex app-server --strict-config` 对未知字段硬报错，
 * 每组都配了 `zzz_bogus = 1` 阴性对照确认探针有区分力）：
 *
 *   codex [mcp_servers.<name>] 接受：
 *     stdio  command / args / cwd / env(子表)
 *     远程   url / bearer_token_env_var / http_headers(子表) / env_http_headers(子表)
 *     通用   enabled / startup_timeout_sec / tool_timeout_sec / enabled_tools
 *     拒绝   description / type / transport
 *     互斥   command 与 url 同时给 → "url is not supported for stdio"
 *
 *   claude McpServerConfig（sdk.d.ts）：
 *     stdio  command / args / env / timeout / alwaysLoad（type 可省略）
 *     远程   url / headers / tools / timeout / alwaysLoad（type: 'sse' | 'http'）
 *
 * 最大的不对称：**codex 没有传输类型判别字段**，只能靠 command/url 推断，所以
 * claude 的 sse 与 http 同步到 codex 会塌缩成同一种写法，回不来。见 describeLoss()。
 */
import type { McpServerConfig, McpTransport } from '@shared/mcp/types'

/** 秒 → 毫秒。codex 的两个超时都是秒。 */
function secToMs(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v * 1000 : undefined
}

/**
 * 毫秒 → 秒，向上取整。
 *
 * ⚠️ **这一步有损**，且是不可逆的：claude 的 `timeout: 1500` → 2s → 回写就成了 2000ms。
 * 所以只在真正跨端写入时调用，同层往返要走 raw 原值（见 McpLocation.raw 的设计）。
 */
function msToSecCeil(v: number | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.ceil(v / 1000) : undefined
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
    // 非字符串值（数字/布尔）静默跳过：两端的 env/headers 都是 string→string，
    // 写进去后端自己也会拒，这里丢掉比把类型污染带进 IR 好。
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((v): v is string => typeof v === 'string')
  return out.length > 0 ? out : undefined
}

// ─────────────────────────────── codex ───────────────────────────────

/** codex 一段 `[mcp_servers.<name>]` 的原始形状（TOML 解析后）。 */
export interface CodexMcpRaw {
  command?: unknown
  args?: unknown
  cwd?: unknown
  env?: unknown
  url?: unknown
  bearer_token_env_var?: unknown
  http_headers?: unknown
  env_http_headers?: unknown
  enabled?: unknown
  startup_timeout_sec?: unknown
  tool_timeout_sec?: unknown
  enabled_tools?: unknown
}

/**
 * codex 段 → 规范化配置。
 *
 * 传输推断：有 `url` 即远程，否则 stdio。远程一律记成 `'http'`——codex 没有字段
 * 能区分 sse/http，猜 http 是因为它是当前 MCP 远程传输的主流（streamable HTTP），
 * 而且这个猜测会被 describeLoss() 如实标成有损，不会假装无损。
 */
export function parseCodexServer(raw: CodexMcpRaw): McpServerConfig {
  const isRemote = typeof raw.url === 'string' && raw.url.trim() !== ''
  const transport: McpTransport = isRemote ? 'http' : 'stdio'

  const config: McpServerConfig = { transport }
  if (isRemote) {
    config.url = raw.url as string
    const headers = stringRecord(raw.http_headers)
    if (headers) config.headers = headers
    const refs = stringRecord(raw.env_http_headers)
    if (refs) config.headerEnvRefs = refs
    if (typeof raw.bearer_token_env_var === 'string') {
      config.bearerTokenEnvVar = raw.bearer_token_env_var
    }
  } else {
    if (typeof raw.command === 'string') config.command = raw.command
    const args = stringArray(raw.args)
    if (args) config.args = args
    if (typeof raw.cwd === 'string') config.cwd = raw.cwd
    const env = stringRecord(raw.env)
    if (env) config.env = env
  }

  const startup = secToMs(raw.startup_timeout_sec)
  if (startup !== undefined) config.startupTimeoutMs = startup
  const tool = secToMs(raw.tool_timeout_sec)
  if (tool !== undefined) config.toolTimeoutMs = tool
  const tools = stringArray(raw.enabled_tools)
  if (tools) config.enabledTools = tools

  return config
}

/** codex 段里的 `enabled` 字段。缺省视为启用（codex 自己也是这个语义）。 */
export function parseCodexEnabled(raw: CodexMcpRaw): boolean {
  return raw.enabled === false ? false : true
}

/**
 * 规范化配置 → codex 段。
 *
 * 只输出 codex 真认识的字段——多写一个 codex 就会在 `--strict-config` 下拒绝启动，
 * 而用户的 config.toml 本来是好的。`alwaysLoad` 这类 claude 独有字段在这里被丢弃，
 * 调用方要靠 describeLoss() 拿到提示后告诉用户。
 */
export function serializeCodexServer(config: McpServerConfig, enabled: boolean): CodexMcpRaw {
  const out: CodexMcpRaw = {}
  if (config.transport === 'stdio') {
    if (config.command !== undefined) out.command = config.command
    if (config.args?.length) out.args = config.args
    if (config.cwd !== undefined) out.cwd = config.cwd
    if (config.env && Object.keys(config.env).length > 0) out.env = config.env
  } else {
    if (config.url !== undefined) out.url = config.url
    if (config.headers && Object.keys(config.headers).length > 0) out.http_headers = config.headers
    if (config.headerEnvRefs && Object.keys(config.headerEnvRefs).length > 0) {
      out.env_http_headers = config.headerEnvRefs
    }
    if (config.bearerTokenEnvVar !== undefined) out.bearer_token_env_var = config.bearerTokenEnvVar
  }
  const startup = msToSecCeil(config.startupTimeoutMs)
  if (startup !== undefined) out.startup_timeout_sec = startup
  const tool = msToSecCeil(config.toolTimeoutMs)
  if (tool !== undefined) out.tool_timeout_sec = tool
  if (config.enabledTools?.length) out.enabled_tools = config.enabledTools
  // enabled 只在禁用时显式写——codex 的缺省就是 true，写上去只会让 config.toml 变吵。
  if (!enabled) out.enabled = false
  return out
}

// ─────────────────────────────── claude ───────────────────────────────

export interface ClaudeMcpRaw {
  type?: unknown
  command?: unknown
  args?: unknown
  env?: unknown
  url?: unknown
  headers?: unknown
  tools?: unknown
  timeout?: unknown
  alwaysLoad?: unknown
}

/**
 * claude 条目 → 规范化配置。
 *
 * `type` 可省略，缺省 stdio（SDK 的语义）。但有 `url` 没 `type` 时按远程处理更稳——
 * 用户手写的配置里省略 type 的远程 server 是常见的。
 */
export function parseClaudeServer(raw: ClaudeMcpRaw): McpServerConfig {
  const declared = typeof raw.type === 'string' ? raw.type.toLowerCase() : null
  const hasUrl = typeof raw.url === 'string' && raw.url.trim() !== ''
  const transport: McpTransport =
    declared === 'sse' || declared === 'http'
      ? (declared as McpTransport)
      : declared === 'stdio'
        ? 'stdio'
        : hasUrl
          ? 'http'
          : 'stdio'

  const config: McpServerConfig = { transport }
  if (transport === 'stdio') {
    if (typeof raw.command === 'string') config.command = raw.command
    const args = stringArray(raw.args)
    if (args) config.args = args
    const env = stringRecord(raw.env)
    if (env) config.env = env
  } else {
    if (typeof raw.url === 'string') config.url = raw.url
    const headers = stringRecord(raw.headers)
    if (headers) config.headers = headers
  }
  const tools = stringArray(raw.tools)
  if (tools) config.enabledTools = tools
  if (typeof raw.timeout === 'number' && Number.isFinite(raw.timeout)) {
    config.startupTimeoutMs = raw.timeout
  }
  if (typeof raw.alwaysLoad === 'boolean') config.alwaysLoad = raw.alwaysLoad
  return config
}

/**
 * 规范化配置 → claude 条目。
 *
 * `type` 总是显式写出：省略虽然合法，但显式写能让 sse/http 的区别在文件里可见，
 * 而这正是从 codex 同步过来时最容易出错的地方。
 */
export function serializeClaudeServer(config: McpServerConfig): ClaudeMcpRaw {
  const out: ClaudeMcpRaw = { type: config.transport }
  if (config.transport === 'stdio') {
    if (config.command !== undefined) out.command = config.command
    if (config.args?.length) out.args = config.args
    if (config.env && Object.keys(config.env).length > 0) out.env = config.env
  } else {
    if (config.url !== undefined) out.url = config.url
    if (config.headers && Object.keys(config.headers).length > 0) out.headers = config.headers
  }
  if (config.enabledTools?.length) out.tools = config.enabledTools
  if (config.startupTimeoutMs !== undefined) out.timeout = config.startupTimeoutMs
  if (config.alwaysLoad !== undefined) out.alwaysLoad = config.alwaysLoad
  return out
}

// ──────────────────────────── 跨端有损分析 ────────────────────────────

export type McpLossKind =
  /** 字段在目标端不存在，会被丢弃。 */
  | 'dropped-field'
  /** sse/http 在 codex 端塌缩成同一种写法，回不来。 */
  | 'transport-collapse'
  /** 秒/毫秒换算把用户的值改了。 */
  | 'timeout-rounding'
  /** 引用式凭据要物化成明文才能写进目标端——默认拒绝，见 mcp-secrets 的边界。 */
  | 'secret-materialization'

export interface McpLoss {
  kind: McpLossKind
  /** 直接显示给用户的中文说明。 */
  message: string
  /** true 时调用方必须拿到用户确认（confirmLossy）才能继续；false 只是提示。 */
  blocking: boolean
}

/**
 * 把一个配置写到目标后端会损失什么。
 *
 * 这是同步操作的**闸门**：调用方先拿这个列表，有 blocking 项就停下来回给用户，
 * 没有就只当提示。v1 设计里那个 `transport-unsupported` 硬阻断已经删掉——
 * 实测 codex 支持远程 MCP，真实约束是「有损」而不是「不支持」。
 */
export function describeLoss(config: McpServerConfig, target: 'codex' | 'claude'): McpLoss[] {
  const out: McpLoss[] = []

  if (target === 'codex') {
    if (config.transport === 'sse') {
      out.push({
        kind: 'transport-collapse',
        message:
          'codex 没有传输类型字段，sse 会被写成与 http 相同的 url 形式；' +
          '若上游只支持 sse，codex 侧可能连不上。',
        blocking: true,
      })
    }
    if (config.alwaysLoad !== undefined) {
      out.push({
        kind: 'dropped-field',
        message: 'codex 不支持 alwaysLoad，该字段会被丢弃。',
        blocking: false,
      })
    }
    if (config.startupTimeoutMs !== undefined && config.startupTimeoutMs % 1000 !== 0) {
      out.push({
        kind: 'timeout-rounding',
        message:
          `启动超时 ${config.startupTimeoutMs}ms 会被向上取整为 ` +
          `${Math.ceil(config.startupTimeoutMs / 1000)}s（codex 只接受整秒）。`,
        blocking: false,
      })
    }
  }

  if (target === 'claude') {
    if (config.cwd !== undefined) {
      out.push({
        kind: 'dropped-field',
        message: 'claude 不支持 cwd，该字段会被丢弃。',
        blocking: false,
      })
    }
    if (config.toolTimeoutMs !== undefined) {
      out.push({
        kind: 'dropped-field',
        message: 'claude 没有单独的工具调用超时，tool_timeout_sec 会被丢弃。',
        blocking: false,
      })
    }
    // 引用变实值：codex 存的是环境变量名，claude 的 headers 要真值。把一个刻意做成
    // 引用的凭据物化成明文落盘，方向是错的——默认拒绝，让用户自己去 claude 侧配。
    if (config.bearerTokenEnvVar !== undefined) {
      out.push({
        kind: 'secret-materialization',
        message:
          `codex 的 bearer_token_env_var（环境变量 ${config.bearerTokenEnvVar}）在 claude 侧` +
          '没有对应写法，需要把凭据明文写进配置文件。catmax 不会自动这么做，请手动在 claude 侧配置。',
        blocking: true,
      })
    }
    if (config.headerEnvRefs && Object.keys(config.headerEnvRefs).length > 0) {
      out.push({
        kind: 'secret-materialization',
        message:
          'codex 的 env_http_headers 是环境变量引用，claude 侧只能写明文值。' +
          'catmax 不会自动解析环境变量，请手动在 claude 侧配置。',
        blocking: true,
      })
    }
  }

  return out
}

/**
 * codex `config/value/write` 的 keyPath 里，一个 TOML 键段该怎么写。
 *
 * **永远加引号。** 实测（codex 0.145.0）：server 名里有点时，不加引号的
 * `mcp_servers.my.server.enabled` 会被当成三层嵌套表，去写一个 `[mcp_servers.my.server]`
 * 新段，然后配置校验报 `Invalid configuration: invalid transport in mcp_servers.my`
 * ——也就是说它是**先写坏再报错**，不是拒绝。加引号的
 * `mcp_servers."my.server".enabled` 正确。
 *
 * 横杠名两种写法都行，所以统一加引号既安全、又不用分情况判断。
 */
export function tomlKeySegment(name: string): string {
  // TOML basic string 的转义规则与 JSON 字符串一致，JSON.stringify 正好产出合法值。
  return JSON.stringify(name)
}

/** `mcp_servers."<name>".<field>` */
export function codexMcpKeyPath(name: string, field: string): string {
  return `mcp_servers.${tomlKeySegment(name)}.${field}`
}

/** `projects."<absPath>".trust_level` —— 项目路径几乎必然带点或空格，同样必须加引号。 */
export function codexTrustKeyPath(folderPath: string): string {
  return `projects.${tomlKeySegment(folderPath)}.trust_level`
}
