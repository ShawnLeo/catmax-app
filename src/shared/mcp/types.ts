/**
 * Unified MCP Server Center: MCP server 的跨后端统一视图。
 *
 * 背景（决定了下面每个字段的形状，见 docs/superpowers/specs/2026-08-03-mcp-server-center-design.md）：
 * - Skill 的实体是「目录 + SKILL.md」，能靠软链桥接；MCP 的实体是「一段配置」，
 *   **没有可软链的东西**。所以这里没有 SkillEntry 的 `unified` / `primary` / `symlink`，
 *   `locations[]` 里每条都是「这个 server 在某个配置文件里的真实写法」，没有本体/镜像之分。
 * - 两个后端**都**支持本地(stdio) 与远程(sse/http)、都有系统/用户/项目多层配置、
 *   都有按名禁用机制。真正的不对称只剩字段细节与密钥表示法（见 McpServerConfig）。
 *
 * ⚠️ 安全：MCP 配置里 routinely 含明文密钥（headers 里的 Bearer token、env 里的 API key）。
 * 跨 IPC 之前必须经 mcp-secrets.ts 脱敏——renderer 永远只拿到 `hasInlineSecret: boolean`，
 * 拿不到值。这条比「renderer 只传 id 不传路径」更要紧：McpSnapshot 是每次 list 都往
 * renderer 推的，一旦不脱敏，密钥就会进入 devtools / 日志 / 错误上报的每一条路径。
 */
import type { BackendId } from '../constants'

/**
 * MCP server 的物理配置来源。
 *
 * codex 侧对应它的七层配置栈（`config/read { includeLayers }` 实测），这里只收录
 * catmax 需要显示或写入的那几层；mdm / enterpriseManaged / legacy 三层归到 `codex-system`
 * 一起当只读展示——它们对用户的可操作性是一样的（都动不了）。
 */
export type McpRootKind =
  | 'codex-system' // /etc/codex/config.toml（含 mdm/企业下发）  仅 codex，只读
  | 'codex-user' // ~/.codex/config.toml                        仅 codex
  | 'codex-project' // <repo>/.codex/config.toml                   仅 codex，trust 门控
  | 'codex-session' // catmax 的 -c 注入层                         仅 codex，不落用户盘
  | 'claude-managed' // managed-mcp.json                            仅 claude，只读
  | 'claude-user' // ~/.claude.json 顶层 mcpServers              仅 claude
  | 'claude-project' // ~/.claude.json projects.<abs>.mcpServers    仅 claude
  | 'claude-mcpjson' // <repo>/.mcp.json                            仅 claude，信任门控
  | 'claude-injected' // catmax 的 Options.mcpServers                仅 claude，不落用户盘

/**
 * 作用域 = **用户能选择把 server 放在哪**，只有两个位置。
 *
 * ⚠️ 这里刻意**没有** `system`。企业/系统管控层（`/etc/codex/config.toml`、
 * `managed-mcp.json`）不是第三个可选位置，而是「别人替你决定了」的同一批全局
 * server 的另一个来源层——用它当第三个 scope 会引出两个真问题：
 *
 * 1. **同名跨层会被拆成两条。** entry 的合并键是 `<scope>:<name>`，而 codex 的七层栈里
 *    用户层就是**覆盖**系统层的同名项的。拆开显示 = 列表里出现两行同名 server，
 *    其中一行是死的（配置在、永远不生效）。合并成一条、把两层摆进 locations[]，
 *    才如实表达"这是同一个 server 的两层定义"。
 * 2. **"能不能写"是 per-location 的，不是 per-scope 的。** 一个 server 完全可能
 *    同时有只读的系统层和可写的用户层。用 scope 表达可写性，这种情况必然判错。
 *
 * 所以只读性走 `McpEntry.managed`（由 locations 的 MCP_ROOT_META.writable 派生）。
 */
export type McpScope = 'global' | 'project'

/**
 * 传输类型。
 *
 * ⚠️ **codex 没有传输类型判别字段**（`type` / `transport` 实测都是
 * `unknown configuration field`），只能靠 `command` / `url` 二选一推断，两者同时给
 * 会报 `url is not supported for stdio`。后果：claude 的 `sse` 与 `http` 同步到 codex 后
 * 会**塌缩成同一种写法**，往回同步时无法还原原本是哪种。这不是阻断，是有损，
 * 扫描/同步要把它记成 lossy 提示而不是假装无损。
 */
export type McpTransport = 'stdio' | 'sse' | 'http'

/**
 * 与后端无关的规范化配置——字段取两端并集，不能表达的在 codec 里降级并记 issue。
 *
 * 超时字段的两个陷阱（都来自实测，别再合并回一个 `timeout`）：
 * 1. codex 有**两个**超时（`startup_timeout_sec` 启动 + `tool_timeout_sec` 工具调用），
 *    claude 只有一个 `timeout`。合成一个会静默丢掉 tool 超时。
 * 2. 秒 ↔ 毫秒**往返有损**：claude `timeout: 1500` → ceil(1.5s) = 2s → 回写 2000ms，
 *    用户的值被悄悄改了。所以 McpLocation.raw 保留原始字段，只在真正跨端写入时换算。
 */
export interface McpServerConfig {
  transport: McpTransport
  // ── stdio ──
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** codex 有，claude 无 → 写 claude 时丢弃 + issue */
  cwd?: string
  // ── 远程 ──
  url?: string
  /** 明文 header 值。两端都支持，但**这就是密钥最常见的藏身处**。 */
  headers?: Record<string, string>
  /** header 名 → 环境变量名（codex `env_http_headers`）。claude 无对应。 */
  headerEnvRefs?: Record<string, string>
  /** codex 独有：Bearer token 的**环境变量名**（不是值）。claude 无对应。 */
  bearerTokenEnvVar?: string
  // ── 通用 ──
  /** codex `startup_timeout_sec`(秒) ↔ claude `timeout`(ms)。这里统一存 ms。 */
  startupTimeoutMs?: number
  /** codex `tool_timeout_sec`(秒)。claude 无 → 跨端丢弃 + issue。这里统一存 ms。 */
  toolTimeoutMs?: number
  /** codex `enabled_tools` ↔ claude `tools` */
  enabledTools?: string[]
  /** claude 独有 → 写 codex 时丢弃 + issue */
  alwaysLoad?: boolean
}

/** 某一层不生效的原因。三种都是「配置在、但没起作用」，必须当一等状态显示。 */
export type McpIneffectiveReason =
  /** codex 项目层未被信任：`<repo>/.codex/config.toml` 存在且被解析，但不合入生效配置。 */
  | 'needs-trust'
  /** claude 的 `.mcp.json` 未被批准（enabledMcpjsonServers / enableAllProjectMcpServers）。 */
  | 'needs-approval'
  /** 被企业名单挡住（claude allowedMcpServers / deniedMcpServers）。 */
  | 'blocked-by-policy'

/** 同一个 server 在某个配置文件里的一处身影。 */
export interface McpLocation {
  kind: McpRootKind
  /**
   * 该 server 在所属配置文件里的「地址」，**仅 main 侧使用，不出 IPC**：
   *   codex-*        → server 名（TOML 段名）
   *   claude-user    → server 名
   *   claude-project → `<absProjectPath>/<serverName>`
   *   claude-mcpjson → `<absFileParentDir>/<serverName>`
   */
  address: string
  /** 配置文件绝对路径（回写用）。session / injected 层没有文件，为 null。 */
  filePath: string | null
  /** 该位置原生被禁用：codex 的 `enabled = false` / claude 的 `disabledMcpServers` 命中。 */
  nativeDisabled: boolean
  /** 该层不生效的原因；null = 生效。detail 存后端给的原文（codex 的 disabledReason）。 */
  ineffective: { reason: McpIneffectiveReason; detail: string } | null
  /** 归一化后的配置。**跨 IPC 前必经脱敏**，renderer 看到的 headers/env 是掩码。 */
  config: McpServerConfig
  /** 该位置的配置里含明文密钥。renderer 靠它显示警示，而不是靠看值。 */
  hasInlineSecret: boolean
}

export interface McpEntry {
  /**
   * 稳定标识 = `<scope>:<name>`，与 SkillEntry.id 同语义。
   *
   * 不用路径：同步和写入都会让路径变，而 server 名不变——两端的开关机制
   * （codex `enabled` / claude `disabledMcpServers`）也都是**纯按名**索引的。
   */
  id: string
  name: string
  scope: McpScope
  /** project scope 时所属的工作区文件夹；global / system 为 null。 */
  folderPath: string | null
  /** 该 server 在各配置源里的全部身影，按 MCP_ROOT_ORDER 排序。 */
  locations: McpLocation[]
  /**
   * 哪些后端**在自己的配置文件里**有它（由 locations[].kind 查 MCP_ROOT_META 得出）。
   *
   * 注意这里**不含**注入进去的——见 injectedInto。两者分开是因为可逆性完全不同：
   * 配置文件里的那份是用户自己写的，catmax 无权替他撤；注入的那份关掉即消失。
   */
  visibleTo: BackendId[]
  /**
   * catmax 通过注入层补给了哪些后端（codex 的 `-c` / claude 的 `Options.mcpServers`）。
   *
   * 这些后端能用它，但它**不在任何配置文件里**——用户在终端里跑同一个后端时看不到。
   * UI 要把这个区别说出来，否则用户会以为 catmax 已经替他配好了。
   */
  injectedInto: BackendId[]
  /**
   * catmax 一处也改不动它——所有 location 都落在只读的系统/企业层。
   *
   * 这是**开关、删除、同步这些写入路径的唯一守卫**：判据必须是"有没有任何一层可写"，
   * 而不是"它是不是系统来的"。一个 server 同时有 `/etc/codex/config.toml` 的只读定义
   * 和 `~/.codex/config.toml` 的用户覆盖时，它是可写的。
   */
  managed: boolean
  /** 用户开关：catmax 状态与各 location 的 nativeDisabled 合并后的结果。 */
  enabled: boolean
  /**
   * 运行时状态，**按后端分开存**。扫描阶段恒为空对象（扫描是纯读、离线可用的）。
   *
   * 为什么不是单个对象：同一个 server 在 codex 里连上了、在 claude 里可能启动失败
   * （本机实测就有一个 `scorpio-mcp-server` 在 claude 侧 failed）。合成一份就必须
   * 挑一个显示，挑哪个都会对另一个后端撒谎。
   *
   * ⚠️ MCP 协议里**配置侧没有 description** —— codex 的 `description` 字段实测是
   * `unknown configuration field`，claude 也没有。它只存在于运行时 `serverInfo` 里，
   * 所以「列表里显示描述」只能走这里，不能指望扫描扫出来。
   */
  runtime: Partial<Record<BackendId, McpRuntimeInfo>>
}

/**
 * 统一的连接状态。
 *
 * `unknown` 是给 codex 用的，不是偷懒：codex 的 `mcpServerStatus/list` 里**没有状态
 * 字段**（实测 topLevelKeys = name/serverInfo/tools/resources/resourceTemplates/authStatus），
 * 只能靠 `serverInfo` 是不是 null 来推断连没连上。而 `serverInfo === null` 同时covers
 * 「被 enabled=false 关掉了」「还在启动」「启动失败」三种情况——本机那个 `enabled = false`
 * 的 `computer-use` 就照样出现在列表里、serverInfo 为 null。把它显示成 failed 是撒谎，
 * 所以老实说不知道。启动状态只能等 `mcpServer/startupStatus/updated` 通知补。
 */
export type McpRuntimeState =
  'connected' | 'connecting' | 'failed' | 'needs-auth' | 'disabled' | 'unknown'

/** codex `McpAuthStatus`。claude 侧没有对应字段。 */
export type McpAuthStatus = 'unsupported' | 'notLoggedIn' | 'bearerToken' | 'oAuth'

export interface McpRuntimeInfo {
  state: McpRuntimeState
  /** MCP 协议 serverInfo 里的描述。实测常常是 null（rmcp 就不填）。 */
  description: string | null
  /** `<serverInfo.name>@<version>`，连上才有。 */
  serverVersion: string | null
  toolCount: number
  authStatus: McpAuthStatus | null
  /** 失败原文，直接显示给用户——「连不上」而不说为什么等于没说。 */
  error: string | null
}

/** 单个后端回报的一条运行时状态。`name` 是 server 名，与配置侧同一个键。 */
export interface McpRuntimeStatus extends McpRuntimeInfo {
  name: string
}

/** 扫描过程中读不动的配置文件——摊给用户看，而不是当作「没有 server」。 */
export interface McpScanIssue {
  path: string
  message: string
}

export interface McpSnapshot {
  entries: McpEntry[]
  issues: McpScanIssue[]
}

/** 每种根的后端可见性、作用域、catmax 能否写。 */
export const MCP_ROOT_META: Record<
  McpRootKind,
  { backends: BackendId[]; scope: McpScope; writable: boolean }
> = {
  'codex-system': { backends: ['codex'], scope: 'global', writable: false },
  'codex-user': { backends: ['codex'], scope: 'global', writable: true },
  'codex-project': { backends: ['codex'], scope: 'project', writable: true },
  'codex-session': { backends: ['codex'], scope: 'global', writable: true },
  'claude-managed': { backends: ['claude'], scope: 'global', writable: false },
  'claude-user': { backends: ['claude'], scope: 'global', writable: true },
  'claude-project': { backends: ['claude'], scope: 'project', writable: true },
  'claude-mcpjson': { backends: ['claude'], scope: 'project', writable: true },
  'claude-injected': { backends: ['claude'], scope: 'global', writable: true },
}

/**
 * locations[] 的排序依据，**同后端内按生效优先级升序**（靠后的覆盖靠前的）。
 *
 * codex 侧就是它七层栈的顺序（system < user < project < sessionFlags，实测）。
 * claude 侧的 managed 与用户层谁压谁**没有端到端验证过**，所以任何"取生效那一份"的
 * 地方都不要依赖这个顺序去猜 claude——用 pickDisplayLocation()，它取的是
 * 「用户唯一能改的那一份」，方向上不会误导。
 */
export const MCP_ROOT_ORDER: McpRootKind[] = [
  'codex-system',
  'codex-user',
  'codex-project',
  'codex-session',
  'claude-managed',
  'claude-user',
  'claude-project',
  'claude-mcpjson',
  'claude-injected',
]

/** renderer 侧看到的密钥掩码。见 mcp-secrets.ts —— 值永远不出 main。 */
export const MCP_SECRET_MASK = '••••••'
