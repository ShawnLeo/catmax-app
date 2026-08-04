/**
 * Unified MCP Server Center: 「在 catmax 里补齐」——把一个后端才有的 MCP server
 * 注入给另一个后端，**不写用户任何配置文件**。
 *
 * 两端各自的注入层（设计文档 §6）：
 * - codex：`-c mcp_servers.<name>.*=...` 的 `sessionFlags` 层，实测优先级**高于** user 层
 *   （同名会覆盖）。spawn 时生效，所以改了要重连 codex。
 * - claude：`Options.mcpServers`，每次 query 构造时传，下一轮就生效，不用重启。
 *
 * 选注入层作默认而不是写用户配置，是因为它把最脏的三件事一次性绕开了：不用替换 TOML
 * 段、不用并发写 `~/.claude.json`、**密钥不落第二份盘**。代价是终端里的 codex/claude
 * 看不到——那是「写入用户配置」（Phase 5）的事，得由用户显式选。
 *
 * ⚠️ 这里拿到的是**未脱敏**的真实配置（要注入就必须是真值）。所以这个模块的返回值
 * 里含明文密钥，**绝不能进 IPC**——它只喂给 spawn 参数和 SDK options。
 */
import type { BackendId } from '@shared/constants'
import type { McpEntry, McpServerConfig } from '@shared/mcp/types'

import { logger } from './logger'
import { serializeClaudeServer } from './mcp-config-codec'
import { scanMcpServersRaw } from './mcp-scanner'
import { readMcpState } from './mcp-state'

const log = logger.domain('mcp-inject')

/**
 * 名字能不能安全地走 codex 的 `-c`。
 *
 * ⚠️ **`-c` 的 keyPath 解析器不支持带引号的段**——这与 `config/value/write` 不同，
 * 那边 `mcp_servers."my.server".enabled` 是好的。实测把
 * `-c 'mcp_servers."my.server".command="npx"'` 传给 codex，它按 `.` 先切再看引号，
 * 于是拿到一个叫 `mcp_servers."my` 的键，然后**整个进程起不来**：
 *
 *     Error: error loading default config after config error: invalid transport
 *     in `mcp_servers."my`
 *
 * 注意失败面有多大：不是"这个 server 没注入成功"，是 **codex 完全启动不了**，
 * 用户会看到整个后端挂掉。所以宁可拒绝注入也不能赌。
 *
 * 逐个实测过的：`-` `_` 空格 大小写 数字都没问题，**只有 `.` 是致命的**。
 * `"` `\` `=` 没有实测（构造不出真实用例），但它们分别能破坏 TOML 字符串、转义和
 * `key=value` 的切分，一并拒掉——这里保守的代价只是少一个可注入的 server。
 */
export function canInjectIntoCodex(name: string): boolean {
  return !/[."\\=\n]/.test(name)
}

/** TOML 标量/数组/内联表的字面量。注入值全靠它，写错了 codex 起不来。 */
function tomlValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return String(Math.trunc(value))
  if (typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(',')}]`
  if (value && typeof value === 'object') {
    // 内联表。实测 `env={FOO="bar",BAZ="qux"}` 能被 `-c` 正确解析成子表。
    const pairs = Object.entries(value as Record<string, unknown>)
      // 键同样不能带点——内联表的键会再被切一次。
      .filter(([key]) => canInjectIntoCodex(key))
      .map(([key, v]) => `${key}=${tomlValue(v)}`)
    return `{${pairs.join(',')}}`
  }
  return '""'
}

/** 一个 server 的全部 `-c` 参数对。 */
export function codexInjectArgsFor(name: string, config: McpServerConfig): string[] {
  const fields: [string, unknown][] = []
  if (config.transport === 'stdio') {
    if (config.command) fields.push(['command', config.command])
    if (config.args?.length) fields.push(['args', config.args])
    if (config.cwd) fields.push(['cwd', config.cwd])
  } else {
    if (config.url) fields.push(['url', config.url])
    if (config.headers && Object.keys(config.headers).length > 0) {
      fields.push(['http_headers', config.headers])
    }
  }
  if (config.env && Object.keys(config.env).length > 0) fields.push(['env', config.env])
  if (config.bearerTokenEnvVar) fields.push(['bearer_token_env_var', config.bearerTokenEnvVar])
  if (config.headerEnvRefs && Object.keys(config.headerEnvRefs).length > 0) {
    fields.push(['env_http_headers', config.headerEnvRefs])
  }
  // 秒 ↔ 毫秒：codex 收的是秒。向上取整，宁可多等一会儿也不要比用户设的更早超时。
  if (config.startupTimeoutMs) {
    fields.push(['startup_timeout_sec', Math.ceil(config.startupTimeoutMs / 1000)])
  }
  if (config.toolTimeoutMs) {
    fields.push(['tool_timeout_sec', Math.ceil(config.toolTimeoutMs / 1000)])
  }
  if (config.enabledTools?.length) fields.push(['enabled_tools', config.enabledTools])

  return fields.flatMap(([key, value]) => ['-c', `mcp_servers.${name}.${key}=${tomlValue(value)}`])
}

/**
 * 挑出「要注入给 targetBackend」的条目。
 *
 * 判据是**目标后端本来看不见它**——已经在目标那边配好的不需要注入，重复注入只会用
 * catmax 这份把用户自己那份盖掉（sessionFlags 优先级更高），等于悄悄改了他的配置。
 */
function pendingFor(entries: McpEntry[], target: BackendId, names: string[]): McpEntry[] {
  const wanted = new Set(names)
  return entries.filter(
    (e) => wanted.has(e.name) && e.enabled && !e.visibleTo.includes(target) && !e.managed,
  )
}

/**
 * codex 的 spawn 参数。
 *
 * **只看全局层**：spawn 是进程级的，那时还不知道用户会打开哪个工作区；而项目级
 * server 的可见性本来就跟着工作区走。把某个项目的 server 注入进一个全局进程，
 * 会让它在所有别的项目里也冒出来。
 */
export function codexMcpInjectArgs(): string[] {
  const state = readMcpState()
  // BackendId 是开放的 string 联合（插件后端也用它），所以索引结果可能不存在。
  const names = state.injected.codex ?? []
  if (names.length === 0) return []
  const snapshot = scanMcpServersRaw()
  const args: string[] = []
  for (const entry of pendingFor(snapshot.entries, 'codex', names)) {
    if (!canInjectIntoCodex(entry.name)) {
      // 名字带点的话，注进去 codex 会整个起不来。宁可少一个 server。
      log.warn('server name cannot be injected into codex via -c, skipped', entry.name)
      continue
    }
    const config = entry.locations[0]?.config
    if (config) args.push(...codexInjectArgsFor(entry.name, config))
  }
  return args
}

/**
 * claude 的 `Options.mcpServers` 补充项。
 *
 * 与 codex 不同，这里能按 cwd 走——claude 的 options 是每次 query 现构的，
 * 那时工作区已经确定了。
 */
export function claudeMcpInjectServers(folderPaths: string[] = []): Record<string, unknown> {
  const state = readMcpState()
  const names = state.injected.claude ?? []
  if (names.length === 0) return {}
  const snapshot = scanMcpServersRaw({ folderPaths })
  const out: Record<string, unknown> = {}
  for (const entry of pendingFor(snapshot.entries, 'claude', names)) {
    const config = entry.locations[0]?.config
    if (config) out[entry.name] = serializeClaudeServer(config)
  }
  return out
}
