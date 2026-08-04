/**
 * Unified MCP Server Center: 各配置源的路径定位。**纯函数，零 IO**——不 stat、不读盘，
 * 只回「该去哪找」，好让 vitest 里不 mock 文件系统也能钉住路径规则。
 *
 * 路径全部经实测确认（codex 用 `config/read { includeLayers }` 读回 layers[].name，
 * claude 用二进制取证 + 真跑 `claude mcp list` 对比），不是照文档抄的。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { McpRootKind, McpScope } from '@shared/mcp/types'

import { resolveBackendConfigDir } from './backend-config-files'

export interface McpRoot {
  kind: McpRootKind
  scope: McpScope
  /** 配置文件绝对路径（可能不存在）。 */
  path: string
  /** project scope 时所属的工作区文件夹；否则 null。 */
  folderPath: string | null
}

/**
 * codex 的系统层。
 *
 * 实测 `config/read` 的 layers[] 里 `{ type: 'system', file }` 就报的这个路径，
 * macOS 和 Linux 都是它（不是 macOS 惯例的 /Library/...）。
 */
export const CODEX_SYSTEM_CONFIG = '/etc/codex/config.toml'

/** codex 用户层：`~/.codex/config.toml`，跟随 $CODEX_HOME。 */
export function codexUserConfigPath(): string {
  return join(resolveBackendConfigDir('codex'), 'config.toml')
}

/**
 * codex 项目层：`<repo>/.codex/config.toml`。
 *
 * ⚠️ 这一层**受 trust 门控**：文件存在也会被 codex 解析并出现在 layers[] 里，但除非
 * 用户的 config.toml 有 `[projects."<abs>"] trust_level = "trusted"`，否则**不合入生效
 * 配置**，codex 会给一条 disabledReason。所以扫到这层的 server 必须判 needs-trust，
 * 否则就是「列表里看得见、实际没生效」——这功能最该避免的撒谎。
 */
export function codexProjectConfigPath(folderPath: string): string {
  return join(folderPath, '.codex', 'config.toml')
}

/**
 * claude 的 `.claude.json`。
 *
 * **不能用 resolveBackendConfigDir('claude') 拼**，两者规则不同（实测 claude 2.1.132）：
 *   CLAUDE_CONFIG_DIR 设了 → `$CLAUDE_CONFIG_DIR/.claude.json`
 *   没设                  → `$HOME/.claude.json`   ← 注意是 ~/ 不是 ~/.claude/
 * 而 resolveBackendConfigDir('claude') 在没设时返回 `~/.claude`。
 *
 * 验证方式：`CLAUDE_CONFIG_DIR=<tmp> claude mcp list` 报 "No MCP servers configured"
 * 并在 <tmp> 下新建 .claude.json；不设时列出 ~/.claude.json 里的真实 server。
 */
export function claudeJsonPath(): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim()
  return join(override ? override : homedir(), '.claude.json')
}

/**
 * claude 的企业 managed MCP 定义。catmax 只读——它由 MDM/管理员下发。
 *
 * 路径来自 claude 二进制的 strings 取证：macOS `/Library/Application Support/ClaudeCode/`，
 * Linux `/etc/claude-code/`，文件名 `managed-mcp.json`。
 */
export function claudeManagedMcpPath(): string {
  return process.platform === 'darwin'
    ? '/Library/Application Support/ClaudeCode/managed-mcp.json'
    : '/etc/claude-code/managed-mcp.json'
}

/** claude 的企业 managed settings（allowed/deniedMcpServers 在这里）。只读。 */
export function claudeManagedSettingsPath(): string {
  return process.platform === 'darwin'
    ? '/Library/Application Support/ClaudeCode/managed-settings.json'
    : '/etc/claude-code/managed-settings.json'
}

/** claude 的用户 settings（enabled/disabledMcpjsonServers 在这里）。 */
export function claudeUserSettingsPath(): string {
  return join(resolveBackendConfigDir('claude'), 'settings.json')
}

/** claude 的仓库共享 MCP：`<repo>/.mcp.json`。 */
export function projectMcpJsonPath(folderPath: string): string {
  return join(folderPath, '.mcp.json')
}

/**
 * 不跟随工作区的根。
 *
 * 系统/企业层与用户层同属 `global` scope：它们是同一批 server 的不同来源层，不是
 * 两个作用域（见 McpScope 的注释）。「只读」由 MCP_ROOT_META.writable 表达。
 */
export function globalRoots(): McpRoot[] {
  return [
    { kind: 'codex-system', scope: 'global', path: CODEX_SYSTEM_CONFIG, folderPath: null },
    { kind: 'codex-user', scope: 'global', path: codexUserConfigPath(), folderPath: null },
    { kind: 'claude-managed', scope: 'global', path: claudeManagedMcpPath(), folderPath: null },
    { kind: 'claude-user', scope: 'global', path: claudeJsonPath(), folderPath: null },
  ]
}

/**
 * 某个工作区文件夹下的项目级根。
 *
 * claude-project 的物理文件是 `~/.claude.json`（按 projects.<abs> 分桶），不是仓库里的
 * 文件——所以它的 path 指向 .claude.json，靠 address 里的 folderPath 区分是哪个桶。
 */
export function projectRoots(folderPath: string): McpRoot[] {
  return [
    {
      kind: 'codex-project',
      scope: 'project',
      path: codexProjectConfigPath(folderPath),
      folderPath,
    },
    { kind: 'claude-project', scope: 'project', path: claudeJsonPath(), folderPath },
    { kind: 'claude-mcpjson', scope: 'project', path: projectMcpJsonPath(folderPath), folderPath },
  ]
}
