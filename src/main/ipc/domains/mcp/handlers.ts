/**
 * Unified MCP Server Center 的 IPC 实现。
 *
 * 安全边界：renderer 只传 `id`（`<scope>:<name>`）和 workspaceId，所有路径都在这里从
 * 扫描结果里查出来；回给 renderer 的 config 一律已脱敏（在 mcp-scanner 的 makeLocation
 * 里统一做，这里不需要也不应该再碰原始密钥）。`trustProject` 是唯一收路径的方法，
 * 它显式校验该路径属于当前工作区。
 */
import { codexConfigWriteErrorCode } from '@main/backend/codex/rpc-error'
import { attachRuntime } from '@main/backend/shared/mcp-runtime-mapping'
import { ctx } from '@main/context'
import { logger } from '@main/service/logger'
import { writeClaudeServer } from '@main/service/mcp-claude-writer'
import {
  describeLoss,
  serializeClaudeServer,
  serializeCodexServer,
} from '@main/service/mcp-config-codec'
import { canInjectIntoCodex } from '@main/service/mcp-inject'
import { projectMcpState, syncMcpOnStartup } from '@main/service/mcp-projection'
import { codexUserConfigPath } from '@main/service/mcp-roots'
import { isInsideFolder, scanMcpServers, scanMcpServersRaw } from '@main/service/mcp-scanner'
import { setMcpEnabled as setMcpEnabledState, setMcpInjected } from '@main/service/mcp-state'
import type { BackendId } from '@shared/constants'
import type { McpActionResult, McpScopeArgs, McpSyncArgs, McpTargetArgs } from '@shared/ipc/mcp'
import type { McpServerConfig, McpSnapshot } from '@shared/mcp/types'
import { shell } from 'electron'

const log = logger.domain('mcp-handler')

/** 当前工作区的所有文件夹（多根工作区每个都算项目级 server 的来源）。 */
function folderPathsOf(workspaceId: string | undefined): string[] {
  if (!workspaceId) return []
  const workspace = ctx.db.findWorkspaceById(workspaceId)
  if (!workspace) return []
  return workspace.folders.map((f) => f.path)
}

function snapshotFor(args: McpScopeArgs): McpSnapshot {
  return scanMcpServers({ folderPaths: folderPathsOf(args.workspaceId) })
}

export const listMcpServers = async (args: McpScopeArgs): Promise<McpSnapshot> => {
  return snapshotFor(args)
}

/**
 * 扫盘 + 运行时状态。
 *
 * 与 `mcp.list` 分成两个方法而不是加个参数，是因为**代价差了两个数量级**：list 是
 * 纯读盘（毫秒级，窗口聚焦时会自动跑），这个要冷启一次 claude 握手再轮询十几秒
 * （见 ClaudeAdapter.listMcpRuntime）。合成一个方法的话，自动重扫会顺带把 claude
 * 拉起来一次，用户切个窗口就白等十几秒。
 *
 * 按名字对齐配置侧与运行时侧——两端的 server 标识本来就都是名字（codex 的 TOML 段名、
 * claude 的 `mcpServers` key），这里不需要也没有别的键可用。
 */
export const refreshMcpRuntime = async (args: McpScopeArgs): Promise<McpSnapshot> => {
  const snapshot = snapshotFor(args)
  // 取工作区第一个文件夹当 cwd：claude 的项目级 server 和 disabledMcpServers 都是
  // per-project 的。多根工作区只探第一个——为每个根各跑一次十几秒的握手不划算，
  // 而绝大多数工作区就是单根。
  const cwd = folderPathsOf(args.workspaceId)[0]
  return attachRuntime(snapshot, await ctx.backendManager.listMcpRuntime(cwd))
}

/**
 * 启动补推：应用没跑的时候用户可能在终端里改过配置，把两端拉回 catmax 的状态。
 *
 * **只扫全局层**——启动时还没有打开的工作区，`folderPathsOf(undefined)` 是空数组。
 * 项目级的投影等用户打开工作区后由第一次开关操作或手动重扫补上；在这里瞎猜一个
 * 工作区去写它的 `.claude.json` 分桶，是往用户配置里写他此刻根本没在用的项目。
 */
export async function syncMcpOnStartupHandler(): Promise<void> {
  try {
    await syncMcpOnStartup(ctx.backendManager.getAdapters(), scanMcpServers(), [])
  } catch (error) {
    log.warn('startup mcp sync failed', error)
  }
}

/**
 * 开 / 关一个 server：先写 catmax 自己的状态，再投影到两个后端。
 *
 * 顺序不能反。catmax 的状态是真相，两端配置是投影——先写状态，即使投影失败（后端
 * 没起来、配置文件只读），下次启动的 syncMcpOnStartup 也会补上。反过来先投影的话，
 * 一端成功一端失败就没有任何地方记得用户到底想要什么。
 *
 * `managed` 的条目直接拒绝：企业下发的配置 catmax 一处也改不动，让它走下去只会在
 * 写入时报一个用户看不懂的权限错误。
 */
export const setMcpEnabled = async (
  args: McpTargetArgs & { enabled: boolean },
): Promise<McpActionResult> => {
  const folderPaths = folderPathsOf(args.workspaceId)
  const before = scanMcpServers({ folderPaths })
  const entry = before.entries.find((e) => e.id === args.id)
  if (!entry) {
    return {
      ok: false,
      code: 'not-found',
      message: '找不到这个 server，可能配置刚被外部改过',
      snapshot: before,
    }
  }
  if (entry.managed) {
    return {
      ok: false,
      code: 'managed',
      message: `${entry.name} 由系统或企业管控层下发，catmax 改不动它`,
      snapshot: before,
    }
  }

  const state = await setMcpEnabledState(entry.name, entry.scope, entry.folderPath, args.enabled)
  // 重扫一次再投影：状态刚变，entry.enabled 得是新的，codex 那边才会写对值。
  const after = scanMcpServers({ folderPaths })
  const { warnings } = await projectMcpState(
    ctx.backendManager.getAdapters(),
    after.entries,
    folderPaths,
    state,
    // codex 侧只写被点的这一个，别把其它 server 的配置文件也顺手改一遍。
    new Set([entry.name]),
  )
  return {
    ok: true,
    ...(warnings.length > 0 ? { warnings } : {}),
    snapshot: scanMcpServers({ folderPaths }),
  }
}

/**
 * 把一整段 server 写进 codex 的用户 config.toml。返回写到了哪，没写成返回 null。
 *
 * 不指定 filePath = 写用户层。项目层不作为写入目标：一个「补给 codex」的 server
 * 本来就来自另一个后端的全局配置，把它塞进某个仓库的 `.codex/config.toml` 既会
 * 进版本库、又要先解 trust 门控。
 */
async function writeCodexServer(name: string, config: McpServerConfig): Promise<string | null> {
  const codex = ctx.backendManager.getAdapters().get('codex')
  if (!codex?.writeMcpServer) return null
  const raw = serializeCodexServer(config, true) as unknown as Record<string, unknown>
  await codex.writeMcpServer(name, raw)
  return codexUserConfigPath()
}

/**
 * 把一个 server 补给另一个后端（注入层）。
 *
 * 「注入」= codex 的 `-c`（sessionFlags 层）/ claude 的 `Options.mcpServers`，
 * **不写用户任何配置文件**，关掉即完全恢复。代价是终端里的后端看不到——
 * 那是 `mode: 'write'`（Phase 5）的事。
 *
 * 有损转换分两级（见 mcp-config-codec 的 describeLoss）：
 * - blocking：默认拒绝，要 `confirmLossy` 才继续。目前只有一种——把 codex 的
 *   `bearer_token_env_var` / `env_http_headers` 转成 claude 需要的明文值，那是
 *   **把引用式凭据实值化**，catmax 不替用户做这个决定。
 * - 非 blocking：直接做，warnings 里如实说明丢了什么。
 */
export const syncMcpServer = async (args: McpSyncArgs): Promise<McpActionResult> => {
  const folderPaths = folderPathsOf(args.workspaceId)
  const snapshot = scanMcpServers({ folderPaths })
  const entry = snapshot.entries.find((e) => e.id === args.id)
  if (!entry) {
    return {
      ok: false,
      code: 'not-found',
      message: '找不到这个 server，可能配置刚被外部改过',
      snapshot,
    }
  }
  if (entry.visibleTo.includes(args.targetBackend)) {
    // 已经在目标那边配好了。再注入一次只会用 catmax 这份把用户自己那份盖掉
    // （codex 的 sessionFlags 优先级更高），等于悄悄改了他的配置。
    return {
      ok: false,
      code: 'already-visible',
      message: `${args.targetBackend} 本来就能看到这个 server`,
      snapshot,
    }
  }

  // ⚠️ 拿的是**未脱敏**的真配置：要把它写给另一个后端跑起来，掩码是没用的。
  // 这份对象一步也不能进 IPC 返回值。
  const rawEntry = scanMcpServersRaw({ folderPaths }).entries.find((e) => e.id === args.id)
  const config = rawEntry?.locations[0]?.config
  if (!config) {
    return { ok: false, code: 'not-found', message: '这个 server 没有可用的配置来源', snapshot }
  }

  if (args.mode === 'inject' && args.targetBackend === 'codex' && !canInjectIntoCodex(entry.name)) {
    // 名字带点的话，`-c` 的 keyPath 解析器会把它切坏，而后果不是"少一个 server"，
    // 是 **codex 整个起不来**。这一条只能拒绝，没有降级方案。
    return {
      ok: false,
      code: 'name-not-injectable',
      message:
        `server 名「${entry.name}」含有点号等字符，codex 的 -c 注入无法表达它` +
        '（会导致 codex 启动失败）。改用下面的「写入 codex 配置」可以绕开——' +
        'config/value/write 的 keyPath 支持带引号的段，`-c` 不支持。',
      snapshot,
    }
  }

  // describeLoss 只认两个内置后端；插件后端没有已知的字段映射表，不能瞎猜有没有损。
  if (args.targetBackend !== 'codex' && args.targetBackend !== 'claude') {
    return {
      ok: false,
      code: 'unsupported-backend',
      message: `暂不支持同步到 ${args.targetBackend}`,
      snapshot,
    }
  }
  const losses = describeLoss(config, args.targetBackend)
  const blocking = losses.filter((l) => l.blocking)
  if (blocking.length > 0 && !args.confirmLossy) {
    return {
      ok: false,
      code: 'needs-confirmation',
      warnings: blocking.map((l) => l.message),
      snapshot,
    }
  }

  const warnings = losses.map((l) => l.message)

  // ── 写入用户配置：把配置**连同其中的凭据**复制到第二个文件 ──
  if (args.mode === 'write') {
    let written: string | null
    try {
      written =
        args.targetBackend === 'codex'
          ? await writeCodexServer(entry.name, config)
          : await writeClaudeServer(entry.name, serializeClaudeServer(config) as never, {
              scope: 'global',
            })
    } catch (error) {
      // codex 把可判别的错误码放在 error.data 里，不翻译的话用户看到的是一句英文散文。
      const failure = codexConfigWriteErrorCode(error)
      if (failure === 'configVersionConflict') {
        return {
          ok: false,
          code: 'version-conflict',
          message: '配置在写入前被别处改过（可能你正开着编辑器或另一个 codex）。请重新扫描后再试。',
          snapshot: scanMcpServers({ folderPaths }),
        }
      }
      log.warn('write mcp server failed', error)
      return { ok: false, code: 'write-failed', message: String(error), snapshot }
    }
    if (!written) {
      return {
        ok: false,
        code: 'write-failed',
        message: '目标后端的配置文件不可写或不存在',
        snapshot,
      }
    }
    // §9.2：必须说清写到了哪，尤其是含凭据的时候。
    warnings.push(
      rawEntry.locations.some((l) => l.hasInlineSecret)
        ? `已写入 ${written}。⚠️ 该配置含明文凭据，现在它在两个文件里各有一份。`
        : `已写入 ${written}，终端里的 ${args.targetBackend} 也能用它了。`,
    )
    return {
      ok: true,
      warnings,
      snapshot: scanMcpServers({ folderPaths }),
    }
  }

  await setMcpInjected(entry.name, args.targetBackend, true)
  // codex 的注入是 **spawn 参数**，跑着的进程看不到——必须重新 apply 一次 settings
  // （把新的 -c 写进 adapter.extraArgs）再重连。顺序与桥开关那条路径一致，反了的话
  // 重 spawn 用的还是旧参数。
  // claude 不用重连：它的 options 是每次 query 现构的，下一轮就带上了。
  if (args.targetBackend === 'codex') {
    ctx.backendManager.applySettings(ctx.settingsStore.load())
    try {
      await ctx.backendManager.reconnectBackend('codex')
      warnings.push('codex 已重连以加载新注入的 server')
    } catch (error) {
      // 重连失败不算同步失败：状态已落盘，codex 下一轮 turn 的 ensureInitialized()
      // 会用新参数重新 spawn。把这句告诉用户，免得他以为没生效而反复点。
      log.warn('codex reconnect after sync failed', error)
      warnings.push('codex 暂时没能重连，新注入的 server 会在下一轮对话时生效')
    }
  }
  return {
    ok: true,
    ...(warnings.length > 0 ? { warnings } : {}),
    snapshot: scanMcpServers({ folderPaths }),
  }
}

/** 取消注入。与 sync 对称，唯一的区别是 codex 侧同样要重连才能真的卸下来。 */
export const unsyncMcpServer = async (
  args: McpTargetArgs & { targetBackend: BackendId },
): Promise<McpActionResult> => {
  const folderPaths = folderPathsOf(args.workspaceId)
  const snapshot = scanMcpServers({ folderPaths })
  const entry = snapshot.entries.find((e) => e.id === args.id)
  if (!entry) {
    return { ok: false, code: 'not-found', message: '找不到这个 server', snapshot }
  }
  await setMcpInjected(entry.name, args.targetBackend, false)
  const warnings: string[] = []
  if (args.targetBackend === 'codex') {
    ctx.backendManager.applySettings(ctx.settingsStore.load())
    try {
      await ctx.backendManager.reconnectBackend('codex')
    } catch (error) {
      log.warn('codex reconnect after unsync failed', error)
      warnings.push('codex 暂时没能重连，该 server 会在下一轮对话时真正卸下')
    }
  }
  return {
    ok: true,
    ...(warnings.length > 0 ? { warnings } : {}),
    snapshot: scanMcpServers({ folderPaths }),
  }
}

/**
 * 把项目加进 codex 的信任列表。
 *
 * 单独一个方法而不是开关的副作用：信任一个项目 = 允许它的 `.codex/config.toml`
 * 注入 hooks 和 exec policies，不只是 MCP。这是安全决策，必须用户显式点。
 */
export const trustCodexProject = async (
  args: McpScopeArgs & { folderPath: string },
): Promise<McpActionResult> => {
  const folderPaths = folderPathsOf(args.workspaceId)
  // 只允许信任当前工作区里的文件夹——renderer 传进来的路径不能直接当成可写目标，
  // 与 mcp.remove 同一条边界。
  if (!folderPaths.includes(args.folderPath)) {
    return {
      ok: false,
      code: 'outside-workspace',
      message: '只能信任当前工作区内的文件夹',
      snapshot: scanMcpServers({ folderPaths }),
    }
  }
  const { failed } = await ctx.backendManager.trustProject(args.folderPath)
  const snapshot = scanMcpServers({ folderPaths })
  if (failed.length > 0) {
    return {
      ok: false,
      code: 'write-failed',
      message: `codex 未能写入信任配置（${failed.join(', ')}）`,
      snapshot,
    }
  }
  return { ok: true, snapshot }
}

/**
 * 删除一个 server 的配置。
 *
 * 三条守卫（设计文档 §10.2），**任何一条不满足就整体拒绝，绝不"删一半"**：
 *
 * 1. **只允许 project scope。** 全局 server 往往是用户在别处精心配的，一个列表里的
 *    删除按钮不该能抹掉它；企业下发的更是碰都不能碰。
 * 2. **每个要动的配置文件都必须在当前工作区内**（`isInsideFolder`，前缀相同但非子目录
 *    要判掉，`/a/foo-bar` 不在 `/a/foo` 里）。renderer 只传 id，路径是这里查出来的，
 *    但查出来之后仍要校验——项目层的 server 也可能来自工作区外的路径。
 * 3. **`~/.claude.json` 是例外但不违反第 2 条**：它的项目级 server 住在
 *    `projects.<abs>` 桶里，文件本身在 home。这时删的是**桶里的 key**，不动文件位置，
 *    判据换成"这个桶的 abs 路径在工作区内"。
 */
export const removeMcpServer = async (args: McpTargetArgs): Promise<McpActionResult> => {
  const folderPaths = folderPathsOf(args.workspaceId)
  const snapshot = scanMcpServers({ folderPaths })
  const entry = snapshot.entries.find((e) => e.id === args.id)
  if (!entry) return { ok: false, message: '找不到这个 server', snapshot }
  if (entry.managed) {
    return {
      ok: false,
      code: 'managed',
      message: `${entry.name} 由企业管控层下发，catmax 删不掉`,
      snapshot,
    }
  }
  if (entry.scope !== 'project') {
    return {
      ok: false,
      code: 'not-project-scoped',
      message: '只能删除项目级 server。全局配置请到对应后端的配置文件里改。',
      snapshot,
    }
  }
  const folder = entry.folderPath
  if (!folder || !folderPaths.includes(folder)) {
    return { ok: false, code: 'outside-workspace', message: '该 server 不属于当前工作区', snapshot }
  }

  // 先整体校验再动手——中途发现越界时前面已经删掉的那些是回不来的。
  for (const location of entry.locations) {
    if (!location.filePath) continue
    // claude 的项目分桶物理上在 home，删的是桶里的 key，不动文件本身。
    if (location.kind === 'claude-project') continue
    if (!isInsideFolder(location.filePath, folder)) {
      return {
        ok: false,
        code: 'outside-workspace',
        message: `${location.filePath} 不在当前工作区内，已整体取消删除`,
        snapshot,
      }
    }
  }

  const removed: string[] = []
  for (const location of entry.locations) {
    if (location.kind === 'codex-project' && location.filePath) {
      const codex = ctx.backendManager.getAdapters().get('codex')
      if (!codex?.removeMcpServer) continue
      await codex.removeMcpServer(entry.name, location.filePath)
      removed.push(location.filePath)
    } else if (location.kind === 'claude-project') {
      const path = await writeClaudeServer(entry.name, null, {
        scope: 'project',
        folderPath: folder,
      })
      if (path) removed.push(path)
    } else if (location.kind === 'claude-mcpjson') {
      // `.mcp.json` 是**团队共享、进版本库**的文件。catmax 删它等于替整个团队做决定，
      // 而且会在别人的 git 里冒出一个没人解释得清的改动。只提示，不动手。
      return {
        ok: false,
        code: 'shared-mcpjson',
        message: `${entry.name} 定义在仓库共享的 .mcp.json 里，那是团队配置——请通过版本控制修改，catmax 不代劳。`,
        snapshot,
      }
    }
  }

  if (removed.length === 0) {
    return { ok: false, code: 'not-found', message: '没有可以删除的配置位置', snapshot }
  }
  return {
    ok: true,
    warnings: [`已从 ${removed.join('、')} 中删除`],
    snapshot: scanMcpServers({ folderPaths }),
  }
}

/**
 * 在访达/资源管理器中显示该 server 所在的配置文件。
 *
 * 取第一个有 filePath 的 location：注入层（codex-session / claude-injected）没有物理
 * 文件，直接跳过而不是报错——一个只存在于 catmax 注入层的 server 本来就没有文件可定位。
 */
export const revealMcpConfig = async (args: McpTargetArgs): Promise<void> => {
  const snapshot = snapshotFor(args)
  const entry = snapshot.entries.find((e) => e.id === args.id)
  if (!entry) {
    log.warn('reveal: entry not found', args.id)
    return
  }
  const target = entry.locations.find((l) => l.filePath !== null)?.filePath
  if (!target) {
    log.warn('reveal: entry has no physical config file', args.id)
    return
  }
  shell.showItemInFolder(target)
}
