/**
 * mcp domain IPC 契约（Unified MCP Server Center）。
 * 函数签名即契约——main 实现，renderer 通过 window.api.mcp 调用。
 *
 * 两条安全边界，缺一不可：
 * 1. **renderer 只传 id（`<scope>:<name>`）+ workspaceId，不传路径。** 路径一律由 main
 *    从扫描结果里查出来。与 skills / backend config files 同一条原则：renderer 能传路径
 *    进来的话，`mcp.remove` 就等价于一个任意文件删除通道。
 * 2. **main 只回脱敏配置，不回密钥。** MCP 配置里 routinely 有明文 token，而 McpSnapshot
 *    是每次 list 都往 renderer 推的。renderer 只拿得到 `hasInlineSecret: boolean`。
 *
 * 所有会改盘的调用都回一份新的 snapshot，省掉调用方的第二次往返，也避免
 * "改完了但列表还是旧的"这种界面撒谎。
 */
import type { BackendId } from '../constants'
import type { McpSnapshot } from '../mcp/types'

export interface McpScopeArgs {
  /** 当前工作区；给了才扫项目级 server（多根工作区会把每个文件夹都扫一遍）。 */
  workspaceId?: string
}

export interface McpTargetArgs extends McpScopeArgs {
  /** `<scope>:<name>`，来自 McpEntry.id */
  id: string
}

/**
 * 失败原因的机器可判别码。
 *
 * 为什么不只靠 `message`：`needs-confirmation` 根本不是失败，是「等你点确认」。
 * 早先版本靠「ok=false 且没有 message 且有 warnings」来推断这件事——那是**从字段缺失
 * 反推语义**，谁后来给那个分支补一句 message，确认弹窗就会无声地变成一个错误提示。
 *
 * 只列**真正会被发出来**的码。设计文档 §10.1 列了一批（`version-conflict`、
 * `permission-denied` …），但没有对应代码路径的先不加：一个永远不出现的码只会让
 * 调用方为不存在的情况写分支。
 */
export type McpFailureCode =
  /** 有损转换，等用户确认后带 confirmLossy 重发。**不是错误。** */
  | 'needs-confirmation'
  /** 扫描结果里找不到这个 id（多半是配置刚被外部改过）。 */
  | 'not-found'
  /** 企业/系统管控层下发，catmax 一处也改不动。 */
  | 'managed'
  /** 目标后端本来就能看到它，不需要同步。 */
  | 'already-visible'
  /** server 名 codex 的 `-c` 表达不了（带点会让 codex 起不来）。 */
  | 'name-not-injectable'
  /** 只能删项目级 server。 */
  | 'not-project-scoped'
  /** 要动的配置文件不在当前工作区内。 */
  | 'outside-workspace'
  /** 定义在仓库共享的 `.mcp.json` 里，属于团队配置。 */
  | 'shared-mcpjson'
  /** 目标配置文件不存在 / 不可写 / 内容已损坏。 */
  | 'write-failed'
  /** 配置在 catmax 读到之后、写进去之前被别处改过（codex 的乐观锁）。 */
  | 'version-conflict'
  | 'unsupported-backend'
  | 'unknown'

export interface McpActionResult {
  ok: boolean
  /** 机器可判别的失败原因。ok=true 时不设。 */
  code?: McpFailureCode
  /** 失败 / 部分成功原因，直接显示给用户。 */
  message?: string
  /**
   * 有损转换的逐条说明。
   *
   * 与 message 分开：message 是"失败了"，warnings 是"能做但会损失这些"。
   * `code: 'needs-confirmation'` 时 warnings 就是要给用户看的确认理由。
   */
  warnings?: string[]
  snapshot: McpSnapshot
}

export async function listMcpServers(_args: McpScopeArgs): Promise<McpSnapshot> {
  throw new Error('implemented in main')
}

/** 开 / 关一个 server：写 catmax 状态 + 投影到两个后端。 */
export async function setMcpEnabled(
  _args: McpTargetArgs & { enabled: boolean },
): Promise<McpActionResult> {
  throw new Error('implemented in main')
}

export interface McpSyncArgs extends McpTargetArgs {
  targetBackend: BackendId
  /**
   * `'inject'` = 只在 catmax 内生效（默认，走 codex 的 -c 层 / claude 的 Options.mcpServers，
   * 不写用户任何文件，可完全逆转）；`'write'` = 写进目标后端的用户配置（终端里也能用，
   * 但会把配置——**包括其中的明文凭据**——复制到第二个文件）。
   */
  mode: 'inject' | 'write'
  /** 用户已看过 warnings 并确认继续。false 时遇到 blocking 的有损项直接返回不执行。 */
  confirmLossy?: boolean
}

/** 把一个 server 补给另一个后端。 */
export async function syncMcpServer(_args: McpSyncArgs): Promise<McpActionResult> {
  throw new Error('implemented in main')
}

/** 取消注入，与 syncMcpServer 对称。 */
export async function unsyncMcpServer(
  _args: McpTargetArgs & { targetBackend: BackendId },
): Promise<McpActionResult> {
  throw new Error('implemented in main')
}

/** 仅项目级、且配置文件确实在当前工作区内的 server 才允许移除。 */
export async function removeMcpServer(_args: McpTargetArgs): Promise<McpActionResult> {
  throw new Error('implemented in main')
}

/** 在访达/资源管理器中显示该 server 所在的配置文件。 */
export async function revealMcpConfig(_args: McpTargetArgs): Promise<void> {
  throw new Error('implemented in main')
}

/**
 * 拉取运行时状态（连接状态 / 工具数 / 描述 / 授权状态）。
 *
 * ⚠️ **这是个慢调用，只能由用户显式动作触发**，不要挂在自动重扫上。
 * codex 侧近乎免费（向已跑着的 app-server 问一句；没跑就跳过，绝不为此 spawn），
 * 但 claude 没有常驻进程，必须现开一次握手再轮询——实测握手 3.2 秒、最后一个 server
 * 在 t+9.2 秒才落定（连接是握手之后异步建立的，读一次永远是 pending）。零 token，但很慢。
 *
 * 拿不到状态的 server 保持 `runtime` 为空。UI 那时显示「未连接」，不能显示成「已连接」。
 */
export async function refreshMcpRuntime(_args: McpScopeArgs): Promise<McpSnapshot> {
  throw new Error('implemented in main')
}

/**
 * 把某个项目加进 codex 的信任列表，解掉 `needs-trust`。
 *
 * 单独开一个方法而不是塞进 setEnabled：信任一个项目意味着允许它的
 * `.codex/config.toml` 注入 hooks 和 exec policies，不只是 MCP——这是个安全决策，
 * 必须由用户显式点，不能作为开关的副作用悄悄发生。
 */
export async function trustCodexProject(
  _args: McpScopeArgs & { folderPath: string },
): Promise<McpActionResult> {
  throw new Error('implemented in main')
}

/**
 * 已注册的 handler。
 *
 * 只列**本期真正实现**的方法——上面那些还没实现的函数留着是为了让契约完整地表达
 * 设计意图（签名先定死，实现时不用再回头改 renderer），但没实现就不该出现在这里：
 * 注册表是"renderer 现在能调什么"的唯一真相，多列一个就会让调用方拿到一个
 * 永远 reject 的 promise，而 TS 那边一点提示都没有。
 *
 * 全部方法均已实现。
 */
export type McpHandlers = {
  'mcp.list': typeof listMcpServers
  'mcp.reveal': typeof revealMcpConfig
  'mcp.refreshRuntime': typeof refreshMcpRuntime
  'mcp.setEnabled': typeof setMcpEnabled
  'mcp.trustProject': typeof trustCodexProject
  'mcp.sync': typeof syncMcpServer
  'mcp.unsync': typeof unsyncMcpServer
  'mcp.remove': typeof removeMcpServer
}
