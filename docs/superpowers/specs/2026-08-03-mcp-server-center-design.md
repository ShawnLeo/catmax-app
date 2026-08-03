# 统一 MCP Server 中心（Unified MCP Server Center）调研与设计

- **状态**：设计稿 v2，待评审（v1 的多条核心前提经实测证伪，见 §0.1）
- **日期**：2026-08-03
- **范围**：让 codex 与 claude 两个后端看到一份统一的 MCP server 列表；扫描各后端真实配置（系统级 / 用户级 / 项目级）；支持 server 的启用 / 禁用；支持把一个后端的 server 补给另一个后端
- **不在范围**：应用内编辑 server 配置正文、claude `strictMcpConfig` 全接管模式、claude.ai 云连接器（claudeai-proxy）的管理、企业 MDM 层的写入
- **探测环境**：codex-cli 0.145.0 · `@anthropic-ai/claude-agent-sdk` 0.3.220（内置 claude 2.1.220）· 另有独立 claude CLI 2.1.132 用于二进制取证 · macOS
- **架构参照**：`docs/superpowers/specs/2026-08-02-unified-skill-center-design.md`（统一技能中心）。本文复用其分层与安全边界，只在两端不对称处另作说明

---

## 0. 本文的事实来源

每一条「实测」都来自本机真跑的探针，不是读文档：

- **codex 协议面**：`codex app-server generate-ts --out <dir>` 导出官方 TS 绑定（92 个 RPC 方法 + 526 个结构体），这是判断 codex 有没有某个能力的**权威来源**，比 `strings` 二进制准。
- **codex 配置面**：在沙盒 `CODEX_HOME` 里逐字段跑 `codex app-server --strict-config`。`--strict-config` 对未知字段**硬报错**，所以「启动成功」= 该字段被 codex 认识。每组都配了 `zzz_bogus = 1` 的**阴性对照**，确认探针本身有区分力。
- **codex 分层面**：真起 app-server 调 `config/read { includeLayers: true, cwd }`，直接读回 `layers[]`。
- **claude 运行时面**：用 `query()` 只握手不发消息（复用 `.claude/skills/slash-command-audit` 的 `neverEndingPrompt` 手法）后调 `mcpServerStatus()`——**不花 token**。
- **claude 配置面**：读 `~/.claude.json`、`sdk.d.ts` 类型定义，并对 claude 二进制做 `strings` 取证。

凡是没跑通的，本文都标了「未验证」。

### 0.1 v1 被证伪的前提（改动最大的部分）

v1 的整体分层、IPC 边界、状态模型方向是对的，但**五条事实性前提是错的**，而且每一条都撑着一大段设计：

| v1 的说法 | 实测 | 影响 |
|---|---|---|
| codex 只支持 stdio，不支持 http/sse | ❌ codex 支持 `url` + `bearer_token_env_var` + `http_headers` + `env_http_headers` | §4.2 的方向约束表、`transport-unsupported` 错误码整段作废 |
| codex 没有任何 MCP 管理 RPC | ❌ 有 5 个：`mcpServerStatus/list`、`config/mcpServer/reload`、`mcpServer/oauth/login`、`mcpServer/tool/call`、`mcpServer/resource/read` | §8.4「不做运行时状态」的理由消失 |
| codex 改完 config.toml 不能热重载，只能等下次 spawn | ❌ `config/mcpServer/reload` + `config/batchWrite { reloadUserConfig: true }` | §5.2、§9.5、§13.4 的「下次会话生效」限制消失 |
| codex 不支持项目级 MCP，只有全局 | ❌ 有 7 层配置栈，含 `project`（`<repo>/.codex/config.toml`，trust 门控）和 `system`（`/etc/codex/config.toml`） | §1.4、§2.1、§3.3 的作用域模型要重做 |
| claude `~/.claude.json` 顶层 server 无法禁用，只能「诚实告知做不到」（方案 B1） | ❌ `projects.<abs>.disabledMcpServers` 按名禁用**任何来源**的 server，SDK 实测生效，用户本机已在用 | §5.3 的 B1 妥协整段删除 |

另有一条 v1 完全没提、但优先级最高的问题：**MCP 配置里含明文密钥**（见 §9），而「扫描 + 显示 + 跨后端复制」这三件事每一件都会搬运密钥。

---

## 1. 结论速览

1. **MCP 与 Skill 的实体差异仍然成立**：Skill 是「目录 + SKILL.md」，靠软链桥接；MCP 是「一段配置」，**没有可软链的目录**。`skill-mirror.ts` 在这里不存在。
2. **但两端的能力对称性远好于 v1 的判断**。两个后端都有：远程 + 本地传输、多层配置（系统/用户/项目）、按名禁用机制、运行时状态查询。真正的不对称只剩字段细节和密钥表示法。
3. **两端都有一个「catmax 专属、不落用户盘」的注入层**，这是本设计与 v1 最大的架构分歧（§6）：
   - codex：`sessionFlags` 层，即 catmax 已在用的 `-c` 覆盖（Protocol Bridge 就走这条）。
   - claude：`Options.mcpServers`，即 Skill 中心 flag 层覆盖的同位物。
   两者都是**叠加**语义（claude 只有 `strictMcpConfig: true` 才变成接管）。所以「把 A 的 server 补给 B」**不必写用户的配置文件**。
4. **开关统一为「按名禁用表」**，两端都能真正生效：codex 写 `enabled = false`（或注入层），claude 写 `disabledMcpServers`。v1 里那个「catmax 标记了但实际还在加载」的诚实性妥协不需要存在。
5. **codex 的配置写入不要手写 TOML**。`config/value/write` / `config/batchWrite` 提供 `keyPath` + `mergeStrategy` + `expectedVersion`（sha256 乐观锁）+ `reloadUserConfig`，格式保留、并发安全、热重载全由 codex 负责。v1 §8.1 的「按段字符串替换」和 §13.1/§13.2 的风险一并消失。

---

## 2. 配置发现路径（实测）

### 2.1 codex 0.145.0：七层配置栈

`config/read { includeLayers: true, cwd }` 的 `layers[].name` 是一个 tagged union（`ConfigLayerSource`），实测返回：

| 层（优先级低 → 高） | `type` | 路径 / 来源 | 能定义 MCP？ | catmax 可写？ |
|---|---|---|---|---|
| MDM | `mdm` | `{ domain, key }` | 是 | 否（企业管控） |
| 系统 | `system` | `/etc/codex/config.toml` | 是 | 否（首版只读展示） |
| 企业下发 | `enterpriseManaged` | `{ id, name }` 云端 | 是 | 否 |
| 用户 | `user` | `~/.codex/config.toml`（+ profile-v2） | 是 | 是 |
| 项目 | `project` | `<repo>/.codex/config.toml` | 是（**trust 门控**） | 是 |
| 会话标志 | `sessionFlags` | `-c key=value` CLI 覆盖 | 是 | **是，且不落用户盘** |
| 遗留管控 | `legacyManagedConfigTomlFrom{File,Mdm}` | — | 是 | 否 |

**项目层的 trust 门控（实测，v1 完全没有覆盖）**：仓库里放 `<repo>/.codex/config.toml` 后，该层会出现在 `layers[]` 里并被解析，但**不会合入生效配置**，而是带一个 `disabledReason`：

```
To load project-local config, hooks, and exec policies, add <repo> as a trusted project in <CODEX_HOME>/config.toml.
```

只有当用户的 `config.toml` 里有

```toml
[projects."/abs/path/to/repo"]
trust_level = "trusted"
```

时，项目层的 `mcp_servers` 才真正合入。实测两种状态都复现过：未信任时 `config.mcp_servers` 只有用户层那条；信任后两条都在。

> **这条对 UI 是硬需求**：一个项目级 codex MCP server 可能「配置文件存在、列表里看得见、但实际没生效」。扫描器必须读 `layers[].disabledReason` 并把它当成一等状态展示（`needs-trust`），否则就是 v1 最想避免的那种「界面显示成功、实际没生效」。

**`[mcp_servers.<name>]` 的完整字段（逐字段 `--strict-config` 实测，含阴性对照）**：

| 字段 | stdio | 远程 | 说明 |
|---|---|---|---|
| `command` | ✅ | — | 有 `command` 即 stdio |
| `args` | ✅ | — | |
| `cwd` | ✅ | — | |
| `env`（子表 `[mcp_servers.<n>.env]`） | ✅ | — | |
| `url` | — | ✅ | 有 `url` 即远程；与 `command` 互斥（同时给报 `url is not supported for stdio`） |
| `bearer_token_env_var` | — | ✅ | **存环境变量名，不存值** |
| `http_headers`（子表） | — | ✅ | 存明文值 |
| `env_http_headers`（子表） | — | ✅ | header 名 → 环境变量名 |
| `enabled` | ✅ | ✅ | 原生开关 |
| `startup_timeout_sec` | ✅ | ✅ | 启动/连接超时 |
| `tool_timeout_sec` | ✅ | ✅ | **工具调用超时，claude 无对应** |
| `enabled_tools` | ✅ | ✅ | 工具级白名单，**claude 侧对应 `tools`** |
| `description` | ❌ | ❌ | 阴性：`unknown configuration field` |
| `type` / `transport` | ❌ | ❌ | 阴性：**没有传输类型判别字段**，靠 `command`/`url` 二选一推断 |

旁证：本机 `~/.codex/config.toml.backup-before-http-sse-20260728` 里有一条 `[mcp_servers.openaiDeveloperDocs] url = "https://developers.openai.com/mcp"`；`~/.codex/mcp-oauth-locks/` 目录存在；协议里有 `mcpServer/oauth/login` 与 `McpAuthStatus = "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth"`。三条独立证据都指向远程 MCP 是一等公民。

### 2.2 codex 的 MCP RPC（v1 说「一个都没有」）

从 `generate-ts` 导出的 `ClientRequest.ts` 里实际存在：

| 方法 | 参数要点 | 用途 |
|---|---|---|
| `mcpServerStatus/list` | `{ detail?: "full" \| "toolsAndAuthOnly", threadId?, cursor }` | 返回 `McpServerStatus { name, serverInfo, tools, resources, resourceTemplates, authStatus }`，分页 |
| `config/mcpServer/reload` | 无参 | **热重载 MCP**，消除「下次会话生效」 |
| `mcpServer/oauth/login` | `{ name, threadId?, scopes?, timeoutSecs? }` | 远程 MCP 的 OAuth 登录 |
| `mcpServer/tool/call` | — | 直接调工具（本设计不用） |
| `mcpServer/resource/read` | — | 读资源（本设计不用） |
| `config/value/write` | `{ keyPath, value, mergeStrategy: "replace"\|"upsert", filePath?, expectedVersion? }` | **通用配置写入**，可指定写哪个文件 |
| `config/batchWrite` | 同上 + `reloadUserConfig?: boolean` | 批量写 + 写完热重载 |

另有通知 `mcpServerStatusUpdated`（`McpServerStatusUpdatedNotification`）——**这是 codex 主动推的状态变更信号**，与 Skill 中心里那个不可靠的 `skills/changed` 不同，它有真实数据（`McpServerStartupState = "starting" | "ready" | "failed" | "cancelled"`）。

`McpServerInfo { name, title, version, description, icons, websiteUrl }` —— **`description` 来自运行时握手，不是配置字段**。v1 §3.2 把 `description` 放进扫描结果并留空是对的，但原因写错了（不是「MCP 协议无此字段」，而是「它在运行时而非配置里」）。

### 2.3 codex 内置的「从其他 agent 导入」

`externalAgentConfig/detect` + `externalAgentConfig/import`，`ExternalAgentConfigMigrationItemType` 含 `MCP_SERVER_CONFIG`（以及 `SKILLS` / `SUBAGENTS` / `HOOKS` / `COMMANDS` / `PLUGINS` / `SESSIONS` / `MEMORY` / `AGENTS_MD`）。`MigrationDetails.mcpServers: McpServerMigration[]`，`ExternalAgentImportedConnectorSource = "remoteMcpServersConfig"`。本机存在 `~/.codex/external_agent_session_imports.json`，说明这条路是活的。

> **对本设计的意义**：claude → codex 方向的同步，codex 官方已经实现了一遍。首版**不接**（它是一次性迁移语义，且 import 是整体的、带自己的进度通知和历史记录，与 catmax 要的「单条 server 双向同步」粒度不符），但要在 §11 里记一笔——如果将来用户要的是「把 claude 整套搬到 codex」，直接转调这两个 RPC 比自己实现正确得多。

### 2.4 claude 2.1.220：六个来源

| 来源 | 作用域 | 路径 | 定义 MCP？ | 开关字段 |
|---|---|---|---|---|
| 企业 managed | 系统 | `/Library/Application Support/ClaudeCode/managed-mcp.json`（macOS）、`/etc/claude-code/managed-mcp.json`（Linux） | 是 | — |
| 企业 settings | 系统 | 同目录 `managed-settings.json` | 否 | `allowedMcpServers` / `deniedMcpServers` |
| 用户全局 | 全局 | `~/.claude.json` 顶层 `mcpServers` | 是 | — |
| 用户 settings | 全局 | `~/.claude/settings.json` | 否 | `enable/disableMcpjsonServers`、`disableClaudeAiConnectors` |
| 项目分桶 | 项目 | `~/.claude.json` 的 `projects.<absPath>.mcpServers` | 是 | 同桶的 **`disabledMcpServers`** |
| 仓库共享 | 项目 | `<repo>/.mcp.json` | 是 | 信任门控 `enabled/disabledMcpjsonServers` |
| SDK 注入 | catmax | `Options.mcpServers`（+ `strictMcpConfig`） | 是 | — |

`sdk.d.ts` 的 `McpServerConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig | McpSdkServerConfigWithInstance`；stdio 有 `command`/`args`/`env`/`timeout`/`alwaysLoad`，sse/http 有 `url`/`headers`/`tools`/`timeout`/`alwaysLoad`。

**企业名单（v1 没提，但它决定了「为什么这个 server 我开不了」）**：`allowedMcpServers` / `deniedMcpServers` 都是 `{ serverName?, serverCommand?, serverUrl? }[]`，按 SDK 注释：*Applies to all scopes including enterprise servers from managed-mcp.json*，且 **denylist 优先**。UI 遇到被企业名单挡住的 server 必须显示成不可操作而不是开关失效。

### 2.5 claude 的通用开关：`projects.<abs>.disabledMcpServers`（推翻 v1 的 B1）

v1 认为 `disabledMcpjsonServers` 只管 `.mcp.json`（这点是对的），并由此推断 `~/.claude.json` 顶层 server 无法禁用。**这个推断是错的**——存在另一个字段 `disabledMcpServers`。

claude 二进制里的实现（`strings` 取证，变量名为压缩后的）：

```js
function Dk(H){ let _ = rA();
  if (nD8(H)) return !(_.enabledMcpServers || []).includes(H);   // builtin claude-vscode 走 opt-in
  return (_.disabledMcpServers || []).includes(H);                // 其余一律走 opt-out
}
```

`rA()` 读的是**项目分桶配置**，`Dk()` 不区分 server 来源——顶层、分桶、`.mcp.json` 一视同仁，纯按名。写入侧 `vgH(name, enabled)` 带 telemetry `tengu_builtin_mcp_toggle` / `mcp_server_toggle`，也就是 CLI 里 `/mcp` 那个开关的落点。

**SDK 端到端实测（关键证据，走的正是 catmax 用的那条路）**：本机 `~/.claude.json` 的 `scorpio-mcp-server` 定义在**顶层**（全局），而 `projects["/Users/shawn/Documents/code/ziroom/yzo2o/yzo2o-libra"].disabledMcpServers = ["scorpio-mcp-server"]`。用 `query()` 握手后调 `mcpServerStatus()`：

```
cwd=catmax-app   => chrome-devtools(pending), scorpio-mcp-server(pending),  web-search-prime(pending)
cwd=yzo2o-libra  => chrome-devtools(pending), scorpio-mcp-server(disabled), web-search-prime(pending)
```

同一个全局 server，换个 cwd 就变 `disabled`。**per-project 禁用全局 server 是能做到的，且 SDK 会把状态如实报成 `disabled`。**

> 由此，v1 §5.3 的方案 B1（「catmax 只记录，诚实告知实际关不掉」）、§13.3 的风险条目、§11 对照表里那一格全部删除。两端的开关都能真生效。

---

## 3. 数据模型

新增 `src/shared/mcp/types.ts`。稳定 id 仍是 `<scope>:<name>`，多处物理身影用 `locations[]` 摊平——这两条 v1 的判断成立，保留。

### 3.1 根源种类与作用域

```ts
// mcp/types.ts

/**
 * MCP server 的物理配置来源。
 * 与 SkillRootKind 的差异：Skill 靠目录，MCP 靠配置文件里的一段。
 * 每一种对应确定的后端可见性与作用域，见 MCP_ROOT_META。
 */
export type McpRootKind =
  | 'codex-system'     // /etc/codex/config.toml            仅 codex，只读
  | 'codex-user'       // ~/.codex/config.toml               仅 codex
  | 'codex-project'    // <repo>/.codex/config.toml          仅 codex，trust 门控
  | 'codex-session'    // catmax 的 -c 注入层                仅 codex，不落用户盘
  | 'claude-managed'   // managed-mcp.json                   仅 claude，只读
  | 'claude-user'      // ~/.claude.json 顶层 mcpServers      仅 claude
  | 'claude-project'   // ~/.claude.json projects.<abs>       仅 claude
  | 'claude-mcpjson'   // <repo>/.mcp.json                    仅 claude，信任门控
  | 'claude-injected'  // catmax 的 Options.mcpServers        仅 claude，不落用户盘

/** system 是企业/系统管控层，catmax 只读。 */
export type McpScope = 'system' | 'global' | 'project'

/** 传输类型。两端都支持本地与远程；codex 无 type 字段，靠 command/url 推断。 */
export type McpTransport = 'stdio' | 'sse' | 'http'
```

> `sse` vs `http` 的不对称要说清楚：claude 用 `type` 显式区分，**codex 没有判别字段**，只有一个 `url`。所以 `claude sse → codex` 与 `claude http → codex` 会塌缩成同一种写法。这不是阻断（不像 v1 说的那样要报 `transport-unsupported`），但是**有损**：往回同步时无法还原原本是 sse 还是 http。扫描器要把这种塌缩记成 `lossy-transport` 提示，而不是假装无损。

### 3.2 规范化配置

```ts
/** 与后端无关的规范化配置。字段取两端并集，不能表达的在 codec 里降级并记 issue。 */
export interface McpServerConfig {
  transport: McpTransport
  // stdio
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string                    // codex 有，claude 无 → 写 claude 时丢弃 + issue
  // 远程
  url?: string
  headers?: Record<string, string>          // 明文值（两端都支持）
  headerEnvRefs?: Record<string, string>    // header 名 → 环境变量名（codex env_http_headers）
  bearerTokenEnvVar?: string                // codex 独有：Bearer token 的环境变量名
  // 通用
  startupTimeoutMs?: number       // codex startup_timeout_sec ↔ claude timeout
  toolTimeoutMs?: number          // codex tool_timeout_sec；claude 无 → 丢弃 + issue
  enabledTools?: string[]         // codex enabled_tools ↔ claude tools
  alwaysLoad?: boolean            // claude 独有 → 写 codex 时丢弃 + issue
}
```

**超时字段的映射陷阱（v1 写错了）**：v1 把 `startup_timeout_sec` 与 claude `timeout` 当同一个，并写「写入时除 1000 向上取整」。问题有两个：

1. codex 有**两个**超时（启动 `startup_timeout_sec` + 工具调用 `tool_timeout_sec`），claude 只有一个 `timeout`。合成一个 `timeout` 字段会静默丢掉 `tool_timeout_sec`。
2. 秒 ↔ 毫秒转换**不是无损的**。`startup_timeout_sec = 120` → 120000ms → 回写 120s，往返安全；但 claude 的 `timeout: 1500` → `ceil(1.5) = 2s` → 回写 2000ms，**用户的值被悄悄改了**。所以往返必须保留原值：`locations[].raw` 存原始字段，只在真正跨端写入时才换算，并把换算记进 issue。

### 3.3 位置与条目

```ts
export interface McpLocation {
  kind: McpRootKind
  /** 该 server 在所属配置文件里的「地址」，仅 main 侧使用，renderer 拿不到。 */
  address: string
  /** 配置文件绝对路径（回写用）。session/injected 层为 null。 */
  filePath: string | null
  /** 该位置原生是否被禁用（codex enabled=false / claude disabledMcpServers 命中）。 */
  nativeDisabled: boolean
  /** 该层是否因未信任 / 企业名单而不生效。null = 生效。
   *  codex-project 未 trust → 'needs-trust'（附 codex 给的 disabledReason 原文）
   *  claude-mcpjson 未批准 → 'needs-approval'
   *  被 deniedMcpServers 挡住 → 'blocked-by-policy' */
  ineffective: { reason: 'needs-trust' | 'needs-approval' | 'blocked-by-policy'; detail: string } | null
  /** 归一化配置。 */
  config: McpServerConfig
  /** 原始字段，往返写入时用来避免有损换算。 */
  raw: unknown
  /** 该位置的配置里是否含明文密钥（见 §9）。 */
  hasInlineSecret: boolean
}

export interface McpEntry {
  id: string                 // `<scope>:<name>`
  name: string
  scope: McpScope
  folderPath: string | null  // project scope 时所属工作区文件夹
  locations: McpLocation[]
  visibleTo: BackendId[]
  enabled: boolean
  /** 运行时握手拿到的元信息，扫描阶段为 null（§8）。 */
  runtime: { description: string | null; toolCount: number; authStatus: string; state: string } | null
}

export interface McpScanIssue { path: string; message: string }
export interface McpSnapshot { entries: McpEntry[]; issues: McpScanIssue[] }
```

### 3.4 可见性与顺序

```ts
export const MCP_ROOT_META: Record<McpRootKind, { backends: BackendId[]; scope: McpScope; writable: boolean }> = {
  'codex-system':    { backends: ['codex'],  scope: 'system',  writable: false },
  'codex-user':      { backends: ['codex'],  scope: 'global',  writable: true  },
  'codex-project':   { backends: ['codex'],  scope: 'project', writable: true  },
  'codex-session':   { backends: ['codex'],  scope: 'global',  writable: true  },
  'claude-managed':  { backends: ['claude'], scope: 'system',  writable: false },
  'claude-user':     { backends: ['claude'], scope: 'global',  writable: true  },
  'claude-project':  { backends: ['claude'], scope: 'project', writable: true  },
  'claude-mcpjson':  { backends: ['claude'], scope: 'project', writable: true  },
  'claude-injected': { backends: ['claude'], scope: 'global',  writable: true  },
}
```

### 3.5 为什么没有 `unified` / `primary` / `symlink`

与 v1 相同，这条判断成立：Skill 的 `unified`/`primary` 来自一个**物理的统一目录**（`~/.agents/skills`）+ 软链；MCP 没有统一目录，「统一」是逻辑层的。`locations[]` 里每条都是真实写法，不存在「谁是本体谁是镜像」。

---

## 4. 同步语义

### 4.1 同步 = 配置复制，不是软链

这条 v1 说对了，保留。Skill 软链保证两边永远一致；MCP 复制之后是独立副本，会漂移。

### 4.2 方向约束（v1 的表整个作废）

v1 的表基于「codex 只支持 stdio」，实测该前提为假。**真实约束只有三条，而且都不是阻断，是有损**：

| 情况 | 结果 |
|---|---|
| stdio 双向 | ✅ 无损（`cwd` 只有 codex 有，写 claude 时丢弃 + issue） |
| 远程 codex → claude | ⚠️ 有损：codex 无 type 字段，需猜 `http`（`sse` 端点会被写错）。默认写 `http`，并在 issue 里要求用户确认 |
| 远程 claude → codex | ⚠️ 有损：`sse`/`http` 塌缩为同一个 `url`；`tools` → `enabled_tools` 可映射 |
| `bearer_token_env_var`（codex）→ claude | ⚠️ **引用变实值**：codex 存的是环境变量名，claude `headers` 要实际值。见 §9.3——**默认拒绝，不自动解析环境变量** |
| `headers` 明文（claude）→ codex | ⚠️ 可写 `http_headers`（明文），也可建议用户改用 `bearer_token_env_var`。见 §9.3 |
| `tool_timeout_sec` / `alwaysLoad` | 单端字段，跨端丢弃 + issue |

所以 `transport-unsupported` 这个错误码删掉，换成 `lossy-conversion`（可继续，需用户确认）与 `secret-materialization-required`（默认拒绝）。

### 4.3 字段映射表

| McpServerConfig | codex TOML | claude JSON |
|---|---|---|
| `transport: 'stdio'` | 有 `command`（无 type 字段） | `type: 'stdio'`（可省略） |
| `transport: 'sse' \| 'http'` | 有 `url`（**无法区分两者**） | `type: 'sse'` / `'http'` |
| `command` / `args` | `command` / `args` | 同名 |
| `env` | 子表 `[mcp_servers.<n>.env]` | `env` |
| `cwd` | `cwd` | **无** → 丢弃 + issue |
| `url` | `url` | `url` |
| `headers` | 子表 `[mcp_servers.<n>.http_headers]` | `headers` |
| `headerEnvRefs` | 子表 `[mcp_servers.<n>.env_http_headers]` | **无** → 需实值化，见 §9.3 |
| `bearerTokenEnvVar` | `bearer_token_env_var` | **无** → 需实值化 |
| `startupTimeoutMs` | `startup_timeout_sec`（秒） | `timeout`（ms） |
| `toolTimeoutMs` | `tool_timeout_sec`（秒） | **无** → 丢弃 + issue |
| `enabledTools` | `enabled_tools` | `tools` |
| `alwaysLoad` | **无** → 丢弃 + issue | `alwaysLoad` |
| 开关 | `enabled = false` | `projects.<abs>.disabledMcpServers` |

归一化/序列化放 `src/main/service/mcp-config-codec.ts`，**纯函数**。往返测试（parse → serialize → parse 幂等）是这个文件的主要单测形态。

---

## 5. 开 / 关 MCP server

两端都能真生效，投影路径不同但都是**按名禁用表**。

### 5.1 持久化层：catmax 自有状态

`src/main/service/mcp-state.ts`：

```ts
/**
 * 按 <scope>:<name> 存，全局与项目分桶。
 *
 * 为什么不像 skill-state 那样单一 disabled 集合：
 * claude 的 disabledMcpServers 本身就是 per-project 的，codex 的项目层也是 per-repo，
 * 同名 server 在不同项目可能是不同配置。混作一谈会让「关项目 A 的 weather」误伤项目 B。
 */
interface McpState {
  globalDisabled: string[]
  projectDisabled: Record<string, string[]>   // folderPath → server 名
}
```

存 `userData/mcp-state.json`，读坏时退化到「全部启用」（与 skill-state 同方向）。

### 5.2 codex 投影

codex 原生有 `enabled`。写入**不要手写 TOML**：

```
config/value/write {
  keyPath: "mcp_servers.<name>.enabled",
  value: false,
  mergeStrategy: "upsert",
  filePath: <该 location 的 config.toml>,   // 省略即用户 config.toml
  expectedVersion: <该层 layers[].version>  // sha256 乐观锁
}
```

然后 `config/mcpServer/reload`（或用 `config/batchWrite { reloadUserConfig: true }` 一步到位）。这一条同时解决了 v1 的三个问题：格式/注释保留（codex 自己负责）、并发写冲突（`expectedVersion` 冲突会失败而不是覆盖）、热重载（不用等下次 spawn）。

**降级路径**：后端进程没起来时无法调 RPC。此时**不为一次开关把 app-server 拉起来**（与 Skill 中心 `refreshSkills` 的处理一致），只写 catmax 状态，冷启动时由 §5.4 的启动补推落盘。

### 5.3 claude 投影

统一用 `~/.claude.json` 的 `projects.<absFolderPath>.disabledMcpServers`——它覆盖所有来源（顶层 / 分桶 / `.mcp.json`），实测生效（§2.5）。

- 全局桶的禁用 → 写进**当前工作区所有 folderPath** 的 `disabledMcpServers`（claude 没有「全局禁用」的位置，只有 per-project）。这是一个真实的语义损耗，UI 要说明「claude 侧的关闭按项目记录」。
- `enabledMcpjsonServers` / `disabledMcpjsonServers` **不用作开关**——它们是 `.mcp.json` 的**信任决策**（批准/拒绝一个仓库带来的 server），语义不是「开关」。catmax 只**读**它们来判断 `ineffective: 'needs-approval'`。

> 与 Skill 中心的一个差异：Skill 的 claude 投影走 flag 层覆盖文件，只影响 catmax 内会话；MCP 的 `disabledMcpServers` 写的是用户自己的 `~/.claude.json`，**用户终端里的 claude 也会跟着关**。这与 codex 侧写 `config.toml` 的影响范围一致，反而对称了。UI 要如实标注（Skill 中心当年是反过来的不对称）。

### 5.4 启动补推

`syncMcpOnStartup()`，在 `register.ts` 启动时 `void` 调用（不 await）：把两端配置与 catmax 状态对齐（应用没跑时用户可能手改过），失败只 warn。

---

## 6. 架构分歧：写用户配置 vs 注入层

这是本设计与 v1 最实质的分歧，也是**评审时最该拍板的一条**。

v1 默认「同步 = 写目标后端的用户配置文件」。但两端都有一个 catmax 专属的叠加层：

| | codex | claude |
|---|---|---|
| 注入方式 | `-c mcp_servers.<n>.command=...`（`sessionFlags` 层） | `Options.mcpServers` |
| 语义 | 叠加在 user/project 之上 | 叠加（`strictMcpConfig: true` 才变接管） |
| catmax 现状 | **已在用**——Protocol Bridge 就走 `codexSpawnArgs()` 的 `-c` | Skill 中心的 flag 层覆盖是同位物 |
| 落用户盘？ | 否 | 否 |

两种方案的取舍：

| | 写用户配置（v1） | 注入层（本文建议作默认） |
|---|---|---|
| 终端里的 codex/claude 也能用 | ✅ | ❌ |
| 可逆性 | 差（要反向删配置段） | 完美（关掉即恢复） |
| 占位冲突 / 格式保留 / 并发写 | 都要处理 | 都不存在 |
| 密钥落新盘 | ✅ 会（§9 的主要风险） | ❌ 不会 |
| 用户在别处加的 server 是否可见 | 可见 | 可见（叠加不是接管） |

**建议**：默认走注入层（「在 catmax 里补齐」），把「写入用户配置」做成显式的进阶操作（「同时让终端里的 codex 也能用」），并在写入前把 §9 的密钥告知摆到界面上。这样首版既拿到了「统一」的核心价值，又把 v1 里最脏的三块（TOML 段替换、`~/.claude.json` 并发写、密钥落盘）全部推迟到用户显式要求时。

---

## 7. 服务分层

```
src/shared/mcp/types.ts                 ── 数据模型
src/shared/ipc/mcp.ts                   ── IPC 契约（renderer 只传 id，不传路径、不收密钥）
src/main/service/mcp-roots.ts           ── 根配置文件定位（纯函数，零 IO）
src/main/service/mcp-config-codec.ts    ── 各格式 ↔ McpServerConfig（纯函数，往返幂等）
src/main/service/mcp-secrets.ts         ── 密钥识别 / 脱敏 / 实值化闸门（§9）
src/main/service/mcp-scanner.ts         ── 扫盘 + 合并 + ineffective 判定
src/main/service/mcp-state.ts           ── 开关状态持久化（global/project 分桶）
src/main/service/mcp-writer.ts          ── 回写：codex 走 config/*Write RPC；claude 走 JSON 子树
src/main/ipc/domains/mcp/handlers.ts    ── 编排层
src/main/ipc/domains/mcp/index.ts       ── handler 注册
```

### 7.1 `mcp-roots.ts`

给出各 `McpRootKind` 的路径。要点：

- `codex-user`：`join(resolveBackendConfigDir('codex'), 'config.toml')`（考虑 `$CODEX_HOME`）。
- `codex-project`：`join(folderPath, '.codex', 'config.toml')`。
- `codex-system`：`/etc/codex/config.toml`（macOS/Linux 都是这个，实测 `layers[]` 里就这么报的）。
- `claude-user` / `claude-project`：都在 `~/.claude.json`。**注意不对称**：claude 的 settings 在 `~/.claude/`，但 `.claude.json` 在 `$HOME`。
  > ⚠️ **未验证**：`$CLAUDE_CONFIG_DIR` 设置时 `.claude.json` 是否跟着移动。实现前要单独探一次，不要照抄 v1 那句「它在 `$HOME` 而非 `$CLAUDE_CONFIG_DIR` 下」——那条没有探针支撑。
- `claude-managed`：macOS `/Library/Application Support/ClaudeCode/managed-mcp.json`，Linux `/etc/claude-code/managed-mcp.json`（二进制 `strings` 实测）。
- `claude-mcpjson`：`join(folderPath, '.mcp.json')`。

### 7.2 `mcp-scanner.ts`

**纯读、离线可用**（没装 codex/claude 也能看列表）——这条 v1 的原则保留，但有一处要改：codex 的 `ineffective: needs-trust` 判定，最准的来源是 `config/read { includeLayers, cwd }` 的 `disabledReason`。折中：

- **离线路径**：直接读文件 + 自己判断 trust（读用户 `config.toml` 的 `[projects."<path>"] trust_level`）。
- **在线增强**：codex 在跑时用 `config/read` 校正，以 codex 自己的 `disabledReason` 原文为准。

流程：算路径 → 逐个读（单个失败 push issue 继续）→ 按 `<scope>:<name>` 合并到 `locations[]` → 合并 enabled = `!(catmax 状态禁用 || 任一 location nativeDisabled)`。

---

## 8. 运行时状态（v1 排除，本文纳入首版只读）

v1 §8.4 排除运行时状态的两条理由都不成立：

1. 「codex 没有等价能力」→ 有 `mcpServerStatus/list`，返回 `serverInfo`（含 `description`/`title`/`version`/`websiteUrl`）、`tools`、`resources`、`authStatus`，还有 `mcpServerStatusUpdated` 主动推送。
2. 「需要活跃会话」→ claude 侧**握手即可**，实测 `query()` 不发消息就能调 `mcpServerStatus()`，**不花 token**。

所以首版就把状态做成**只读增强**：

- 两端后端在跑时拉一次状态，填 `McpEntry.runtime`（`description` / `toolCount` / `authStatus` / `state`）。
- 后端没跑就是 `runtime: null`，UI 显示「未连接」，**不显示成「已连接」**。
- `authStatus: 'notLoggedIn'` 的远程 server 给一个「登录」入口 → codex 调 `mcpServer/oauth/login`；claude 侧 `~/.claude/mcp-needs-auth-cache.json` 已存在，说明它有自己的授权流，首版只展示不接管。

「配置存在 ≠ 已连接」这条 v1 的文案要求仍然成立，而且现在有真状态可显示，更该做准。

---

## 9. 密钥处理（v1 完全缺失，优先级最高）

MCP 配置里**routinely 含明文密钥**。本机 `~/.claude.json` 的 `web-search-prime` 就是 `headers: { Authorization: "Bearer <token>" }`，token 明文躺在一个 `0600` 的文件里。

这与 CLAUDE.md 里 Protocol Bridge 那条既定边界直接冲突：

> 密钥写 `userData/bridge-credentials.json`（`0600`），**绝不进 `settings.json`**（`0644`、会被备份、renderer 能整体读）；**只 renderer → main 单向**，IPC 只回 `credentialReady: boolean`，从不回传密钥。

MCP 中心要做的三件事，每件都在搬运密钥。规则：

### 9.1 密钥不出 main

`McpLocation.config` 里的 `headers` / `env` **在跨 IPC 之前必须脱敏**。renderer 拿到的是 `{ Authorization: '••••••' }` + `hasInlineSecret: true`，永远拿不到值。`mcp-secrets.ts` 负责识别（key 名匹配 `authorization|token|secret|key|password|api[-_]?key`，值形似 token）与脱敏。

> 这条比 v1 的「renderer 只传 id 不传路径」更关键：路径泄露的后果是任意文件访问，密钥泄露的后果是凭据外流，而且 `McpSnapshot` 是**每次 list 都往 renderer 推的**——一旦不脱敏，密钥就会进入 Vue devtools、日志、错误上报的每一条路径。

### 9.2 密钥不落新盘

「同步到另一后端」如果走写用户配置，就是把密钥**复制到第二个文件**。这直接违反「密钥只存一处」。所以：

- 默认走 §6 的注入层——密钥在 main 内存里从源配置读出、直接交给 spawn/SDK，不落任何新文件。
- 用户显式要求写入用户配置时，必须弹一次明确告知：「这会把凭据明文写入 `<目标文件>`」，并在结果里说清写到了哪。

### 9.3 引用 vs 实值：默认拒绝实值化

codex 的 `bearer_token_env_var` / `env_http_headers` 存的是**环境变量名**，claude 的 `headers` 存的是**值**。

- **codex → claude**：需要把环境变量解析成实值才能写。这等于「把一个刻意做成引用的凭据，物化成明文落盘」。**默认拒绝**，返回 `secret-materialization-required`，提示用户手动在 claude 侧配置。绝不自动读 `process.env` 去填。
- **claude → codex**：可以写 `http_headers`（明文，与源同等暴露，可接受），但 UI 应优先建议 `bearer_token_env_var` + 用户自己设环境变量——这是**降低**暴露面的方向，值得推。

### 9.4 `~/.claude.json` 的备份反而是风险

v1 §8.2 提出写前备份成 `.claude.json.catmax-bak`。**这条要撤销**：该文件含明文凭据，多一份备份就多一个 `0600` 之外可能失控的副本（备份文件的权限、是否被 Time Machine/云盘同步，都不在 catmax 控制内）。改为依赖 `config/value/write` 式的乐观锁 + 原子 rename，不留额外副本。

---

## 10. IPC 契约（`src/shared/ipc/mcp.ts`）

安全边界两条：**renderer 只传 id + workspaceId，不传路径**（同 skills / backend config files）；**main 只回脱敏配置，不回密钥**（§9.1）。

```ts
export interface McpScopeArgs { workspaceId: string }
export interface McpTargetArgs extends McpScopeArgs { id: string }

export interface McpActionResult {
  ok: boolean
  /** 失败 / 部分成功原因，直接显示给用户。 */
  message?: string
  /** 有损转换的逐条说明（用户确认前先看这个）。 */
  warnings?: string[]
  snapshot: McpSnapshot
}

export interface McpSyncArgs extends McpTargetArgs {
  targetBackend: BackendId
  /** 'inject' = 只在 catmax 内生效（默认）；'write' = 写入目标后端用户配置。 */
  mode: 'inject' | 'write'
  /** 用户已看过 warnings 并确认继续。false 时遇到有损转换直接返回 warnings 不执行。 */
  confirmLossy?: boolean
}
```

| 方法 | 作用 | 改盘？ |
|---|---|---|
| `listMcpServers` | 扫描所有来源，返回脱敏 snapshot | 否 |
| `setMcpEnabled` | 开/关（持久化 + 双投影） | 是 |
| `syncMcpServer` | 补给另一后端（inject 或 write） | 视 mode |
| `removeMcpServer` | 移除配置段（守卫见下） | 是 |
| `revealMcpConfig` | 访达中显示配置文件 | 否 |
| `refreshMcpRuntime` | 拉运行时状态（§8） | 否 |
| `trustCodexProject` | 把当前项目加进 codex 信任列表（解 `needs-trust`） | 是 |

### 10.1 错误码

```ts
export type McpWriteFailure =
  | 'occupied-by-different-config'    // 目标已有同名但配置不同，拒绝覆盖
  | 'lossy-conversion'               // 有损，需 confirmLossy
  | 'secret-materialization-required'// 引用→实值，默认拒绝（§9.3）
  | 'blocked-by-policy'              // 企业 allowed/deniedMcpServers 挡住
  | 'needs-trust'                    // codex 项目层未信任
  | 'version-conflict'               // expectedVersion 不匹配（并发写）
  | 'permission-denied'
  | 'invalid-config'
  | 'parse-error'
  | 'unknown'
```

`transport-unsupported` 从 v1 删除——前提为假。

### 10.2 `removeMcpServer` 守卫

1. `scope` 必须是 `project`（全局/系统不让在 catmax 里删）。
2. 每个 location 的 `filePath` 必须在工作区文件夹内（`isInsideFolder`，前缀相同但非子目录要判掉）。
   - `<repo>/.mcp.json`、`<repo>/.codex/config.toml` → ✅
   - `~/.claude.json` 的 `projects.<path>` → 文件在 home，走「从子树删 key」，不动文件本身
3. 越界整体拒绝，不做「删一半」。

---

## 11. 与 Skill 中心的对照表（已按实测修正）

| 维度 | Skill 中心 | MCP 中心 |
|---|---|---|
| 实体 | 目录 + SKILL.md | 配置段 |
| 统一手段 | 软链（`~/.agents/skills`） | 配置复制 / **注入层**（§6） |
| codex 发现 | `skills/list` RPC | 读 config.toml **或** `config/read`（有 RPC） |
| codex 开关 | `skills/config/write` | `config/value/write` + `enabled` 字段 |
| codex 重载 | `skills/list { forceReload }` | **`config/mcpServer/reload`** |
| codex 作用域 | user / repo | **system / user / project(trust 门控) / sessionFlags** |
| claude 发现 | SDK 自扫 `~/.claude/skills` | `~/.claude.json` + `.mcp.json` + `managed-mcp.json` |
| claude 开关 | `settings.skillOverrides`（仅 catmax 内） | **`projects.<abs>.disabledMcpServers`（含用户终端）** |
| 开关影响范围 | codex 全局 / claude 仅 catmax（**不对称**） | 两端都影响用户终端（**对称**） |
| 状态作用域 | 单一全局 disabled 集合 | global + project 分桶 |
| 删除 | `rm -rf` 目录 | 删配置段（可恢复） |
| 跨端类型兼容 | 无 | 有损但不阻断（sse/http 塌缩） |
| 密钥 | 无 | **有，且是首要约束（§9）** |
| 运行时状态 | 基本没有 | **两端都有，首版纳入只读** |
| 官方迁移工具 | 无 | codex `externalAgentConfig/import`（§2.3） |

---

## 12. 分阶段实施计划

### Phase 1：数据模型与扫描（只读）
- `shared/mcp/types.ts`、`shared/ipc/mcp.ts`
- `mcp-roots.ts`、`mcp-config-codec.ts`、**`mcp-secrets.ts`（脱敏必须与扫描同期，不能后补）**、`mcp-scanner.ts`
- `ipc/domains/mcp/`（`listMcpServers` + `revealMcpConfig`）、`preload/api.ts`
- 设置页 `McpSection.vue` 只读列表
- **验收**：列出两端所有来源的 server，标出 scope / 单端双端 / 漂移 / `ineffective` 原因；**renderer 侧断言拿不到任何密钥明文**

### Phase 2：运行时状态（只读增强）
- `refreshMcpRuntime`：codex `mcpServerStatus/list`、claude 握手后 `mcpServerStatus()`
- 订阅 codex `mcpServerStatusUpdated`
- **验收**：连接状态/工具数/authStatus 正确；后端没跑时显示「未连接」而非「已连接」

### Phase 3：开关
- `mcp-state.ts`；`setMcpEnabled` 双投影
- codex 走 `config/value/write` + `config/mcpServer/reload`；claude 写 `disabledMcpServers`
- `trustCodexProject`；`syncMcpOnStartup`
- **验收**：关 codex server 后**同一会话内**即时生效（热重载）；关 claude 全局 server 后 `mcpServerStatus()` 报 `disabled`

### Phase 4：同步（默认注入层）
- codex `-c` 注入接进 `codexSpawnArgs()`；claude 接进 `Options.mcpServers`
- `syncMcpServer({ mode: 'inject' })` + 有损警告链路
- **验收**：单端 server 在另一端可用，且**两端用户配置文件字节未变**

### Phase 5：写入用户配置 + 删除 + popover
- `mcp-writer.ts` 完整写入（含 §9.2 的告知）
- `removeMcpServer` 守卫；`ProjectMcpPopover.vue`
- **验收**：写入后终端里的后端也能用；全局 server 不让删

### Phase 6：打磨
- 漂移检测、错误码全链路 UI 翻译、`AGENTS.md` 补 MCP domain

---

## 13. 风险与未决项

1. **`$CLAUDE_CONFIG_DIR` 对 `.claude.json` 的影响未验证**（§7.1）。实现前必须单独探一次。
2. **`disabledMcpServers` 的写入侧未端到端验证**：读侧已实测生效（§2.5），但 catmax 写进去之后 claude 是否立刻认（还是要重启会话）没跑过。Phase 3 的验收就是这条。
3. **codex `expectedVersion` 的获取时机**：`layers[].version` 是 sha256，从 `config/read` 拿到到 `config/value/write` 之间有窗口。冲突时返回 `version-conflict` 让上层重读重试，不要静默覆盖。
4. **codex 后端没跑时无法用 RPC 写配置**。降级为只写 catmax 状态 + 启动补推（§5.2），**不要**为一次开关拉起 app-server。
5. **claude 的「全局禁用」只能 per-project 表达**（§5.3），多根工作区下要写多个桶，且用户新开一个项目时该 server 会「复活」。UI 必须说明这个语义损耗。
6. **有损同步的往返丢失**：`sse` → codex → 回 claude 会变成 `http`。`raw` 字段能缓解单跳，但多跳往返仍会丢。UI 对「双端漂移」的提示要包含这种由同步自身引入的漂移。
7. **企业 MDM / managed 层只读**，但它们会让用户的开关「看起来没生效」。必须把 `blocked-by-policy` 显示成不可操作而不是失败的开关。
8. **`~/.claude.json` 并发写**：claude CLI 自己也在写这文件（缓存、project 记录）。走 read-modify-write + 原子 rename 缩小窗口；**不做备份文件**（§9.4）。若冲突频发，加 mtime 检测（`backend-config-files.ts` 已有此模式）。

---

## 附录 A：探针命令（可复现）

```bash
# codex 协议全表
codex app-server generate-ts --out /tmp/codexts
grep -o '"[a-zA-Z/]*[Mm]cp[a-zA-Z/]*"' /tmp/codexts/ClientRequest.ts | sort -u

# codex 字段探测（--strict-config 对未知字段硬报错；务必配阴性对照 zzz_bogus = 1）
printf '[mcp_servers.probe]\nurl = "https://x.invalid/mcp"\nbearer_token_env_var = "T"\n' > $CODEX_HOME/config.toml
echo '{"method":"initialize","id":1,"params":{"clientInfo":{"name":"p","title":"p","version":"0.0.1"}}}' \
  | codex app-server --strict-config

# codex 分层 + trust 门控
# config/read { includeLayers: true, cwd } → layers[].name / .config.mcp_servers / .disabledReason

# claude 运行时状态（握手即可，不花 token）
# query({ prompt: neverEndingGenerator(), options: { cwd } }) → await q.mcpServerStatus()

# claude 二进制取证
strings /usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe \
  | grep -oE ".{140}disabledMcpServers.{200}" | grep -v whiteList
```
