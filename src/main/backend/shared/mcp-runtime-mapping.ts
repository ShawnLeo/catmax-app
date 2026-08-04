/**
 * Unified MCP Server Center: 两个后端的 MCP 运行时状态 → 统一 McpRuntimeStatus。
 *
 * 与 assess-risk.ts 同样的定位：跨后端共用的纯策略，放这里免得每个 adapter 各判一套。
 * 全部纯函数，不碰进程也不碰盘——adapter 只负责把原始响应递进来。
 *
 * 两端给的东西**很不对称**，下面每条都实测过（codex 0.145.0 / claude 2.1.220）：
 *
 * | | codex `mcpServerStatus/list` | claude `mcpServerStatus()` |
 * |---|---|---|
 * | 状态字段 | **没有**，只能靠 serverInfo 推断 | 有 `status` 五态 |
 * | 失败原因 | 没有（只在启动通知里） | 有 `error` |
 * | 工具 | `tools` 是 **map** | `tools` 是 **数组** |
 * | authStatus | 有 | 没有 |
 * | 时机 | initialize 后立即可读 | **握手后全是 pending，要等几秒** |
 */
import type { BackendId } from '@shared/constants'
import type { McpAuthStatus, McpRuntimeStatus, McpSnapshot } from '@shared/mcp/types'

/** codex `McpServerStatus`（generate-ts 导出的 v2 类型，这里只取用得上的字段）。 */
export interface CodexMcpServerStatusRaw {
  name?: unknown
  serverInfo?: { name?: unknown; version?: unknown; description?: unknown } | null
  tools?: Record<string, unknown> | null
  authStatus?: unknown
}

const AUTH_STATUSES: McpAuthStatus[] = ['unsupported', 'notLoggedIn', 'bearerToken', 'oAuth']

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asAuthStatus(value: unknown): McpAuthStatus | null {
  return AUTH_STATUSES.find((s) => s === value) ?? null
}

/**
 * codex 的一条状态。
 *
 * ⚠️ **不要把 `serverInfo === null` 映射成 failed。** 实测本机 `enabled = false` 的
 * `computer-use` 照样出现在 list 里、serverInfo 为 null——它没坏，是被关了。同一个
 * 形状还covers「还在启动」。codex 这个响应里根本没有状态字段，所以只有连上（有
 * serverInfo）是能确定的，其余一律 unknown，让调用方拿配置侧的 enabled 去补。
 */
export function mapCodexMcpStatus(raw: CodexMcpServerStatusRaw): McpRuntimeStatus | null {
  const name = asString(raw.name)
  if (!name) return null
  const info = raw.serverInfo ?? null
  const infoName = asString(info?.name)
  const infoVersion = asString(info?.version)
  return {
    name,
    state: info ? 'connected' : 'unknown',
    description: asString(info?.description),
    serverVersion: infoName ? `${infoName}${infoVersion ? `@${infoVersion}` : ''}` : null,
    // codex 的 tools 是 map（`{ [name]: Tool }`），claude 是数组——别把这两个搞混。
    toolCount: Object.keys(raw.tools ?? {}).length,
    authStatus: asAuthStatus(raw.authStatus),
    error: null,
  }
}

/** `mcpServer/startupStatus/updated` 通知里攒下来的东西。 */
export interface CodexMcpStartupState {
  /** codex `McpServerStartupState`：starting | ready | failed | cancelled */
  status: string
  error: string | null
  /** failureReason === 'reauthenticationRequired'（协议里目前唯一的取值）。 */
  needsAuth: boolean
}

/**
 * 用启动通知把 `mcpServerStatus/list` 推断不出来的状态补上。
 *
 * **只在列表给出 unknown 时才覆盖。** 列表里有 serverInfo 是「现在连着」的直接证据，
 * 而通知是攒下来的历史——一条几分钟前的 failed 不该把一个此刻明明连着的 server
 * 标成失败。方向上宁可少说，不可说错。
 */
export function applyCodexStartupState(
  status: McpRuntimeStatus,
  startup: CodexMcpStartupState | undefined,
): McpRuntimeStatus {
  if (!startup || status.state !== 'unknown') return status
  const state =
    startup.status === 'ready'
      ? 'connected'
      : startup.status === 'starting'
        ? 'connecting'
        : startup.status === 'failed'
          ? startup.needsAuth
            ? 'needs-auth'
            : 'failed'
          : startup.status === 'cancelled'
            ? 'failed'
            : 'unknown'
  return {
    ...status,
    state,
    // cancelled 没有 error 文案，但用户看到"启动失败"总得知道是被取消的。
    error: startup.error ?? (startup.status === 'cancelled' ? '启动已取消' : null),
  }
}

/** claude `McpServerStatus`（SDK 类型，同样只取用得上的字段）。 */
export interface ClaudeMcpServerStatusRaw {
  name?: unknown
  status?: unknown
  serverInfo?: { name?: unknown; version?: unknown } | null
  tools?: unknown[] | null
  error?: unknown
}

/** claude 的五态 → 统一态。它没有 authStatus，也没有 description。 */
export function mapClaudeMcpStatus(raw: ClaudeMcpServerStatusRaw): McpRuntimeStatus | null {
  const name = asString(raw.name)
  if (!name) return null
  const infoName = asString(raw.serverInfo?.name)
  const infoVersion = asString(raw.serverInfo?.version)
  return {
    name,
    state:
      raw.status === 'connected'
        ? 'connected'
        : raw.status === 'failed'
          ? 'failed'
          : raw.status === 'needs-auth'
            ? 'needs-auth'
            : raw.status === 'disabled'
              ? 'disabled'
              : raw.status === 'pending'
                ? 'connecting'
                : 'unknown',
    description: null,
    serverVersion: infoName ? `${infoName}${infoVersion ? `@${infoVersion}` : ''}` : null,
    toolCount: Array.isArray(raw.tools) ? raw.tools.length : 0,
    authStatus: null,
    error: asString(raw.error),
  }
}

/**
 * claude 的连接是**握手之后才异步建立的**，所以一次性读是读不到结果的。
 *
 * 实测（本机 3 个 server）：`initializationResult()` 返回时（t+3.2s）三个全是 pending；
 * t+5.2s 一个转 failed；t+9.2s 两个转 connected（29 / 1 个工具）。也就是说
 * 「握手完就调一次 mcpServerStatus()」拿到的永远是 pending —— 那正是设计文档 §8
 * 原本写的做法，实测证伪。必须轮询到全部落定或超时。
 */
export function allSettled(statuses: McpRuntimeStatus[]): boolean {
  return statuses.length > 0 && statuses.every((s) => s.state !== 'connecting')
}

/**
 * 把各后端回报的状态挂回扫描出来的 entry 上，**原地改**。
 *
 * 按名字对齐：两端的 server 标识本来就都是名字（codex 的 TOML 段名、claude 的
 * `mcpServers` key），没有别的键可用。
 *
 * ⚠️ 必须先过 `visibleTo`。少了这一步，一个只在 codex 里配了的 server 会因为
 * 名字撞车拿到 claude 的状态——两个后端各配一个同名但完全不同的 server 并不罕见
 * （`github`、`filesystem` 这种通用名尤其），那时显示的工具数和版本全是另一个东西的。
 *
 * **后端回报了但扫描里没有的 server 会被静默丢掉，这是有意的。** 实测 codex 会多报一个
 * `codex_apps`（plugin-runtime@0.1.0，36 个工具，bearerToken），它不在任何配置文件里——
 * 是 codex 内建的。把它塞进列表等于给用户看一个他改不了、也不该改的条目，而这个
 * 功能是**配置管理**，不是进程监视器。
 */
export function attachRuntime(
  snapshot: McpSnapshot,
  byBackend: Partial<Record<BackendId, McpRuntimeStatus[]>>,
): McpSnapshot {
  for (const [backend, statuses] of Object.entries(byBackend) as [
    BackendId,
    McpRuntimeStatus[],
  ][]) {
    const byName = new Map(statuses.map((s) => [s.name, s]))
    for (const entry of snapshot.entries) {
      if (!entry.visibleTo.includes(backend)) continue
      const status = byName.get(entry.name)
      if (!status) continue
      const { name: _name, ...runtime } = status
      entry.runtime[backend] = runtime
    }
  }
  return snapshot
}
