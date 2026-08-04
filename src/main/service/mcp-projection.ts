/**
 * Unified MCP Server Center: 把 catmax 的开关状态投影到两个后端。
 *
 * catmax 自己的 `mcp-state.json` 是**真相**，两端的配置是它的投影。这么定的原因是
 * 两端的禁用位置根本不对称——codex 是配置文件里 server 自己的 `enabled` 字段，
 * claude 是 `~/.claude.json` 里按项目分桶的一张名单，没有哪一边能表达另一边的语义。
 * 硬选一边当真相，另一边就永远在做有损翻译。
 *
 * 由此带来一个必须如实告诉用户的语义损耗：**claude 侧的「全局禁用」只能落到
 * 当前工作区的每个文件夹上**（claude 没有全局禁用的位置）。换个新项目，那个
 * server 会"复活"，直到 syncMcpOnStartup 或下一次开关把它补上。
 *
 * 两端**都**写用户自己的配置文件，终端里的 codex / claude 会跟着变——这一点与
 * Skill 中心不同（那边 claude 侧只影响 catmax 内会话），UI 要标注。
 */
import type { AgentBackend } from '@shared/backend/types'
import type { McpEntry, McpSnapshot } from '@shared/mcp/types'
import { MCP_ROOT_META } from '@shared/mcp/types'

import { logger } from './logger'
import { writeClaudeDisabledServers } from './mcp-claude-writer'
import { claudeDisabledNamesFor, readMcpState, type McpState } from './mcp-state'

const log = logger.domain('mcp-projection')

/**
 * 该往哪个文件写 codex 的 `enabled`。
 *
 * 必须是**该 server 真正定义在的那个可写文件**：codex 写入时校验整份配置，往一个
 * 没有该 server 定义的文件里写 `enabled` 会以 `invalid transport` 失败（实测）。
 * 所以不能图省事一律写用户 config.toml——项目层定义的 server 得写回项目层。
 *
 * 返回 null = 这个 server 在 codex 侧没有可写的定义（只在系统层，或者压根不在
 * codex 里），调用方应当跳过而不是猜一个路径。
 */
export function codexWriteTarget(entry: McpEntry): string | null {
  for (const location of entry.locations) {
    const meta = MCP_ROOT_META[location.kind]
    if (!meta.backends.includes('codex') || !meta.writable) continue
    if (location.filePath) return location.filePath
  }
  return null
}

export interface ProjectionResult {
  /** 直接显示给用户的说明；空 = 两端都干净地投影成功了。 */
  warnings: string[]
}

/**
 * 把当前状态投影到两端。
 *
 * @param entries 本次扫描到的全部条目——codex 侧要靠它查每个 server 的写入目标。
 * @param folderPaths 当前工作区的所有文件夹；claude 侧的名单按文件夹写。
 * @param onlyNames 只投影这些 server（codex 侧）。单次开关传被点的那一个；
 *   启动补推不传，走全量。claude 侧不受它影响——那边写的是一张完整名单，
 *   只写一部分反而会把别的禁用项抹掉。
 *
 * 单端失败不阻断另一端：catmax 自己的状态已经落盘，一端没推成下次启动会补。
 * 但要把失败摊给用户看——静默失败会变成"我明明关了它却还在用"。
 */
export async function projectMcpState(
  adapters: Map<string, AgentBackend>,
  entries: McpEntry[],
  folderPaths: string[],
  state: McpState = readMcpState(),
  onlyNames?: Set<string>,
): Promise<ProjectionResult> {
  const warnings: string[] = []

  // ── codex：逐个 server 写它自己的 enabled ──
  const codex = adapters.get('codex')
  if (codex?.setMcpEnabled) {
    for (const entry of entries) {
      if (!entry.visibleTo.includes('codex')) continue
      // 单次开关只写被点的那一个。不加这层的话，每点一次开关都会把所有 codex
      // server 重写一遍——写入本身是幂等的，但每次都会改配置文件的 mtime，
      // 而 codex 自己也在看这个文件。
      if (onlyNames && !onlyNames.has(entry.name)) continue
      const target = codexWriteTarget(entry)
      // 只在系统层定义的 server 改不动——UI 已经用 managed 拦住了开关，
      // 这里再兜一层，免得 syncMcpOnStartup 这类批量路径绕过去。
      if (!target) continue
      try {
        await codex.setMcpEnabled(entry.name, entry.enabled, target)
      } catch (error) {
        log.warn('codex projection failed', entry.name, error)
        warnings.push(`codex 侧未能写入 ${entry.name}：${String(error)}`)
      }
    }
  }

  // ── claude：每个文件夹一张名单 ──
  // 注意这里写的是**全集**而不是增量：claude 的 disabledMcpServers 就是一张完整名单，
  // 增量式地往里加会让"在别处手动删掉一条"永远补不回来。
  if (folderPaths.length > 0) {
    const byFolder = new Map(folderPaths.map((f) => [f, claudeDisabledNamesFor(state, f)]))
    try {
      await writeClaudeDisabledServers(byFolder)
    } catch (error) {
      log.warn('claude projection failed', error)
      warnings.push(`claude 侧未能写入 ~/.claude.json：${String(error)}`)
    }
  } else if (state.globalDisabled.length > 0) {
    // 没有打开工作区就没有 folderPath 可写——claude 侧这次投影不了。
    warnings.push(
      'claude 侧的禁用按项目记录，当前没有打开工作区，本次未能同步到 claude。' +
        '打开工作区后会自动补上。',
    )
  }

  return { warnings }
}

/**
 * 启动补推：应用没跑的时候用户可能在终端里手改过配置，这里把两端拉回 catmax 状态。
 *
 * 在 register.ts 里 `void` 调用（不 await）：它要等 codex 起来才有意义，而阻塞启动
 * 去等一个后端进程是本末倒置。失败只 warn——补推是尽力而为，用户下次点开关就会重推。
 */
export async function syncMcpOnStartup(
  adapters: Map<string, AgentBackend>,
  snapshot: McpSnapshot,
  folderPaths: string[],
): Promise<void> {
  const state = readMcpState()
  if (state.globalDisabled.length === 0 && Object.keys(state.projectDisabled).length === 0) {
    // 一个都没关过就没什么可推的。绕过去能省掉一次对每个 server 的写入尝试——
    // 那些写入即使是幂等的，也会改动用户配置文件的 mtime。
    return
  }
  const { warnings } = await projectMcpState(adapters, snapshot.entries, folderPaths, state)
  for (const warning of warnings) log.warn('startup sync:', warning)
}
