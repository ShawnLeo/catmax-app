/**
 * Unified MCP Server Center: 扫盘，把散落在 8 个配置源里的 MCP server 合成一份统一视图。
 *
 * **纯读、离线可用**——设置页要在 codex 没装、claude 没起的时候也能显示列表。
 * 后端只在两处才用得上：投影开关（mcp-state 的调用方）和运行时状态（§8 的增强）。
 *
 * 三条不显然的规则，都来自实测：
 * 1. **codex 项目层受 trust 门控**：`<repo>/.codex/config.toml` 存在也会被解析，但除非
 *    用户 config.toml 里有 `[projects."<abs>"] trust_level = "trusted"`，否则不合入生效
 *    配置。扫到就必须标 needs-trust，否则列表里看得见、实际没生效。
 * 2. **claude 的 .mcp.json 受信任门控**：要被 enabledMcpjsonServers 或
 *    enableAllProjectMcpServers 批准过才生效，被 disabledMcpjsonServers 拒绝的则否。
 * 3. **claude 的 disabledMcpServers 覆盖所有来源**（顶层/分桶/.mcp.json 一视同仁，纯按名），
 *    所以它是 nativeDisabled 的判据，而不是只对 .mcp.json 生效。
 *
 * ⚠️ 返回的 snapshot 里所有 config 都**已脱敏**（见 mcp-secrets.ts）。需要真配置的
 * 写入路径必须自己重读原文件，不能拿 snapshot 里的值去写——那是掩码。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { BackendId } from '@shared/constants'
import {
  MCP_ROOT_META,
  MCP_ROOT_ORDER,
  type McpEntry,
  type McpLocation,
  type McpRootKind,
  type McpScanIssue,
  type McpScope,
  type McpServerConfig,
  type McpSnapshot,
} from '@shared/mcp/types'
import { parse as parseToml } from 'smol-toml'

import { logger } from './logger'
import {
  parseClaudeServer,
  parseCodexEnabled,
  parseCodexServer,
  type ClaudeMcpRaw,
  type CodexMcpRaw,
} from './mcp-config-codec'
import {
  claudeJsonPath,
  claudeManagedMcpPath,
  claudeUserSettingsPath,
  codexProjectConfigPath,
  codexUserConfigPath,
  CODEX_SYSTEM_CONFIG,
  projectMcpJsonPath,
} from './mcp-roots'
import { hasInlineSecret, redactConfig } from './mcp-secrets'
import { isDisabled, readMcpState, type McpState } from './mcp-state'

const log = logger.domain('mcp-scanner')

/** 配置文件再大也不该无脑读进来。`~/.claude.json` 本机就有 87KB，还会继续长。 */
const MAX_CONFIG_BYTES = 8 * 1024 * 1024

interface RawServer {
  name: string
  scope: McpScope
  folderPath: string | null
  location: McpLocation
}

function readTextFile(path: string, issues: McpScanIssue[]): string | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8')
    if (raw.length > MAX_CONFIG_BYTES) {
      issues.push({ path, message: `配置文件过大（${raw.length} 字节），已跳过` })
      return null
    }
    return raw
  } catch (error) {
    // 单个文件读不动就记 issue 继续扫下一个——一个 EACCES 不该让整张列表打不开。
    issues.push({ path, message: `无法读取：${String(error)}` })
    return null
  }
}

function readTomlFile(path: string, issues: McpScanIssue[]): Record<string, unknown> | null {
  const raw = readTextFile(path, issues)
  if (raw === null) return null
  try {
    return parseToml(raw) as Record<string, unknown>
  } catch (error) {
    issues.push({ path, message: `TOML 解析失败：${String(error)}` })
    return null
  }
}

function readJsonFile(path: string, issues: McpScanIssue[]): Record<string, unknown> | null {
  const raw = readTextFile(path, issues)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      issues.push({ path, message: 'JSON 顶层不是对象' })
      return null
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    issues.push({ path, message: `JSON 解析失败：${String(error)}` })
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * 本次扫描要不要脱敏。
 *
 * 默认 true，且**只有 scanMcpServersRaw 一个入口能把它关掉**——见那个函数的注释。
 * 用模块级变量而不是层层传参：makeLocation 在六个调用点上，多一个参数就多六处
 * 可能传错的地方，而这是安全不变量，不能靠"每处都记得传对"。
 */
let redactionEnabled = true

function makeLocation(
  kind: McpRootKind,
  address: string,
  filePath: string | null,
  config: McpServerConfig,
  nativeDisabled: boolean,
  ineffective: McpLocation['ineffective'],
): McpLocation {
  return {
    kind,
    address,
    filePath,
    nativeDisabled,
    ineffective,
    // 脱敏发生在这里，是唯一的出口——所有 location 都经过 makeLocation，
    // 所以不存在"某条路径忘了脱敏"的漏网之鱼。
    config: redactionEnabled ? redactConfig(config) : config,
    hasInlineSecret: hasInlineSecret(config),
  }
}

// ─────────────────────────────── codex ───────────────────────────────

/**
 * 用户 config.toml 里被信任的项目列表。
 *
 * codex 的形状是 `[projects."<abs>"] trust_level = "trusted"`。只有 `"trusted"` 算数，
 * 其它值（含缺失）一律当不信任——这里必须保守，猜错的方向应该是"提示用户去信任"
 * 而不是"以为生效了"。
 */
function readCodexTrustedProjects(userToml: Record<string, unknown> | null): Set<string> {
  const out = new Set<string>()
  const projects = asRecord(userToml?.projects)
  if (!projects) return out
  for (const [path, value] of Object.entries(projects)) {
    const entry = asRecord(value)
    if (entry?.trust_level === 'trusted') out.add(path)
  }
  return out
}

function scanCodexToml(
  kind: McpRootKind,
  path: string,
  scope: McpScope,
  folderPath: string | null,
  parsed: Record<string, unknown> | null,
  ineffective: McpLocation['ineffective'],
  out: RawServer[],
): void {
  const servers = asRecord(parsed?.mcp_servers)
  if (!servers) return
  for (const [name, value] of Object.entries(servers)) {
    const raw = asRecord(value)
    if (!raw) continue
    const config = parseCodexServer(raw as CodexMcpRaw)
    out.push({
      name,
      scope,
      folderPath,
      location: makeLocation(
        kind,
        name,
        path,
        config,
        !parseCodexEnabled(raw as CodexMcpRaw),
        ineffective,
      ),
    })
  }
}

// ─────────────────────────────── claude ───────────────────────────────

interface ClaudeGates {
  /** projects.<abs>.disabledMcpServers —— 覆盖所有来源的按名禁用。 */
  disabledByFolder: Map<string, Set<string>>
  /** .mcp.json 的信任门控。 */
  enableAllByFolder: Map<string, boolean>
  enabledJsonByFolder: Map<string, Set<string>>
  disabledJsonByFolder: Map<string, Set<string>>
}

function emptyGates(): ClaudeGates {
  return {
    disabledByFolder: new Map(),
    enableAllByFolder: new Map(),
    enabledJsonByFolder: new Map(),
    disabledJsonByFolder: new Map(),
  }
}

function collectClaudeGates(
  claudeJson: Record<string, unknown> | null,
  userSettings: Record<string, unknown> | null,
): ClaudeGates {
  const gates = emptyGates()
  const projects = asRecord(claudeJson?.projects)
  if (projects) {
    for (const [folder, value] of Object.entries(projects)) {
      const bucket = asRecord(value)
      if (!bucket) continue
      const names = (key: string): Set<string> =>
        new Set(
          (Array.isArray(bucket[key]) ? (bucket[key] as unknown[]) : []).filter(
            (n): n is string => typeof n === 'string',
          ),
        )
      gates.disabledByFolder.set(folder, names('disabledMcpServers'))
      gates.enabledJsonByFolder.set(folder, names('enabledMcpjsonServers'))
      gates.disabledJsonByFolder.set(folder, names('disabledMcpjsonServers'))
      if (typeof bucket.enableAllProjectMcpServers === 'boolean') {
        gates.enableAllByFolder.set(folder, bucket.enableAllProjectMcpServers)
      }
    }
  }
  // 用户 settings.json 里的同名字段是全局兜底，用一个空字符串 key 存，查询时并入。
  if (userSettings) {
    const globalNames = (key: string): Set<string> =>
      new Set(
        (Array.isArray(userSettings[key]) ? (userSettings[key] as unknown[]) : []).filter(
          (n): n is string => typeof n === 'string',
        ),
      )
    gates.enabledJsonByFolder.set('', globalNames('enabledMcpjsonServers'))
    gates.disabledJsonByFolder.set('', globalNames('disabledMcpjsonServers'))
    if (typeof userSettings.enableAllProjectMcpServers === 'boolean') {
      gates.enableAllByFolder.set('', userSettings.enableAllProjectMcpServers)
    }
  }
  return gates
}

/** `.mcp.json` 来源的 server 是否已被批准。未批准 = 配置在但不生效。 */
function mcpJsonIneffective(
  gates: ClaudeGates,
  folderPath: string,
  name: string,
): McpLocation['ineffective'] {
  if (gates.disabledJsonByFolder.get(folderPath)?.has(name)) {
    return { reason: 'needs-approval', detail: '已在该项目的 disabledMcpjsonServers 中被拒绝' }
  }
  if (gates.disabledJsonByFolder.get('')?.has(name)) {
    return {
      reason: 'needs-approval',
      detail: '已在用户 settings.json 的 disabledMcpjsonServers 中被拒绝',
    }
  }
  const approved =
    gates.enableAllByFolder.get(folderPath) === true ||
    gates.enableAllByFolder.get('') === true ||
    gates.enabledJsonByFolder.get(folderPath)?.has(name) === true ||
    gates.enabledJsonByFolder.get('')?.has(name) === true
  if (approved) return null
  return {
    reason: 'needs-approval',
    detail:
      '仓库共享的 .mcp.json server 需要先被批准（enabledMcpjsonServers / enableAllProjectMcpServers）',
  }
}

function scanClaudeServers(
  kind: McpRootKind,
  path: string,
  scope: McpScope,
  folderPath: string | null,
  servers: Record<string, unknown> | null,
  gates: ClaudeGates,
  addressPrefix: string,
  ineffectiveFor: (name: string) => McpLocation['ineffective'],
  out: RawServer[],
): void {
  if (!servers) return
  for (const [name, value] of Object.entries(servers)) {
    const raw = asRecord(value)
    if (!raw) continue
    const config = parseClaudeServer(raw as ClaudeMcpRaw)
    // disabledMcpServers 是纯按名、覆盖所有来源的：一个定义在顶层的全局 server
    // 也会被某个项目桶里的这份名单关掉（实测：同一 server 换 cwd 后 SDK 报 disabled）。
    const disabledHere = folderPath
      ? gates.disabledByFolder.get(folderPath)?.has(name) === true
      : false
    out.push({
      name,
      scope,
      folderPath,
      location: makeLocation(
        kind,
        `${addressPrefix}${name}`,
        path,
        config,
        disabledHere,
        ineffectiveFor(name),
      ),
    })
  }
}

// ─────────────────────────────── 合并 ───────────────────────────────

function visibilityOf(locations: McpLocation[]): BackendId[] {
  const seen = new Set<BackendId>()
  for (const loc of locations) for (const id of MCP_ROOT_META[loc.kind].backends) seen.add(id)
  return [...seen].sort()
}

function toEntry(head: RawServer, raws: RawServer[], state: McpState): McpEntry {
  const locations = [...raws]
    .sort(
      (a, b) => MCP_ROOT_ORDER.indexOf(a.location.kind) - MCP_ROOT_ORDER.indexOf(b.location.kind),
    )
    .map((r) => r.location)

  return {
    id: `${head.scope}:${head.name}`,
    name: head.name,
    scope: head.scope,
    folderPath: head.folderPath,
    locations,
    visibleTo: visibilityOf(locations),
    // 注入是 catmax 自己的状态，不在任何配置文件里，所以只能从 state 读。
    injectedInto: Object.entries(state.injected)
      .filter(([, names]) => names.includes(head.name))
      .map(([backend]) => backend)
      .sort(),
    // 一处也改不动才算 managed。只要有一层可写（典型是用户层覆盖系统层），
    // 开关/删除/同步就该是可用的——所以判据是 every 而不是 some。
    managed: locations.every((l) => !MCP_ROOT_META[l.kind].writable),
    // catmax 状态与后端原生禁用取或——任一说关就是关，UI 才不会显示成开着。
    enabled:
      !isDisabled(state, head.name, head.scope, head.folderPath) &&
      !locations.some((l) => l.nativeDisabled),
    // 扫描阶段没有运行时信息（description 只存在于运行时 serverInfo 里，配置侧两端都没有）。
    runtime: {},
  }
}

export interface McpScanOptions {
  /** 当前工作区的所有文件夹（多根工作区每个都扫）。空 = 只扫全局与系统。 */
  folderPaths?: string[]
}

export function scanMcpServers(options: McpScanOptions = {}): McpSnapshot {
  const issues: McpScanIssue[] = []
  const state = readMcpState()
  const folderPaths = options.folderPaths ?? []
  const raws: RawServer[] = []

  // ── codex ──
  const codexUserPath = codexUserConfigPath()
  const codexUserToml = readTomlFile(codexUserPath, issues)
  const trusted = readCodexTrustedProjects(codexUserToml)

  // 系统层归 global scope（不是单独的 scope）——它与用户层是同一批 server 的两层定义，
  // codex 的用户层就是覆盖系统层同名项的。拆成两个 scope 会让同名 server 在列表里
  // 出现两行，其中一行永远不生效。只读性走 entry.managed，见 McpScope 的注释。
  scanCodexToml(
    'codex-system',
    CODEX_SYSTEM_CONFIG,
    'global',
    null,
    readTomlFile(CODEX_SYSTEM_CONFIG, issues),
    null,
    raws,
  )
  scanCodexToml('codex-user', codexUserPath, 'global', null, codexUserToml, null, raws)

  for (const folder of folderPaths) {
    const path = codexProjectConfigPath(folder)
    const parsed = readTomlFile(path, issues)
    if (!parsed) continue
    scanCodexToml(
      'codex-project',
      path,
      'project',
      folder,
      parsed,
      trusted.has(folder)
        ? null
        : {
            reason: 'needs-trust',
            detail: `codex 未信任该项目，<repo>/.codex/config.toml 不会生效。需在 ${codexUserPath} 添加 [projects."${folder}"] trust_level = "trusted"`,
          },
      raws,
    )
  }

  // ── claude ──
  const claudePath = claudeJsonPath()
  const claudeJson = readJsonFile(claudePath, issues)
  const userSettings = readJsonFile(claudeUserSettingsPath(), issues)
  const gates = collectClaudeGates(claudeJson, userSettings)

  const managedPath = claudeManagedMcpPath()
  const managed = readJsonFile(managedPath, issues)
  scanClaudeServers(
    'claude-managed',
    managedPath,
    'global',
    null,
    asRecord(managed?.mcpServers),
    gates,
    '',
    () => null,
    raws,
  )

  scanClaudeServers(
    'claude-user',
    claudePath,
    'global',
    null,
    asRecord(claudeJson?.mcpServers),
    gates,
    '',
    () => null,
    raws,
  )

  const claudeProjects = asRecord(claudeJson?.projects)
  for (const folder of folderPaths) {
    const bucket = asRecord(claudeProjects?.[folder])
    scanClaudeServers(
      'claude-project',
      claudePath,
      'project',
      folder,
      asRecord(bucket?.mcpServers),
      gates,
      `${folder}/`,
      () => null,
      raws,
    )

    const mcpJsonPath = projectMcpJsonPath(folder)
    const mcpJson = readJsonFile(mcpJsonPath, issues)
    scanClaudeServers(
      'claude-mcpjson',
      mcpJsonPath,
      'project',
      folder,
      asRecord(mcpJson?.mcpServers),
      gates,
      `${dirname(mcpJsonPath)}/`,
      (name) => mcpJsonIneffective(gates, folder, name),
      raws,
    )
  }

  // 按 `<scope>:<name>` 分组——全局和项目同名是两条独立记录，不该合并显示。
  const grouped = new Map<string, RawServer[]>()
  for (const raw of raws) {
    const key = `${raw.scope}:${raw.name}`
    const bucket = grouped.get(key)
    if (bucket) bucket.push(raw)
    else grouped.set(key, [raw])
  }

  const scopeRank: Record<McpScope, number> = { global: 0, project: 1 }
  const entries = [...grouped.values()]
    .flatMap((group) => (group[0] ? [toEntry(group[0], group, state)] : []))
    .sort((a, b) =>
      a.scope === b.scope ? a.name.localeCompare(b.name) : scopeRank[a.scope] - scopeRank[b.scope],
    )

  if (issues.length > 0) log.info('scan finished with issues', issues.length)
  return { entries, issues }
}

/**
 * 不脱敏的扫描。**返回值含明文密钥，绝不能进 IPC。**
 *
 * 唯一的合法用途是注入层（mcp-inject.ts）：要把一个 server 交给另一个后端跑起来，
 * 就必须给它真实的 token，掩码是跑不起来的。
 *
 * 名字里带 Raw、单独一个导出、而不是给 scanMcpServers 加个 `redact: false` 参数——
 * 参数式的开关在调用点上看不出危险性，`scanMcpServers({ redact: false })` 混在一堆
 * 正常调用里没人会多看一眼；`scanMcpServersRaw()` 则会让 review 的人停一下。
 *
 * try/finally 保证异常路径也把开关恢复回去：漏掉一次，之后所有正常扫描就都不脱敏了。
 */
export function scanMcpServersRaw(options: McpScanOptions = {}): McpSnapshot {
  redactionEnabled = false
  try {
    return scanMcpServers(options)
  } finally {
    redactionEnabled = true
  }
}

/** 用于「删除」的守卫：某个配置文件在不在给定的工作区文件夹里。 */
export function isInsideFolder(target: string, folderPath: string): boolean {
  if (target === folderPath) return true
  // 前缀相同但不是子目录的要判掉（/a/foo-bar 不在 /a/foo 里）。
  return target.startsWith(folderPath.endsWith('/') ? folderPath : `${folderPath}/`)
}
