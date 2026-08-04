/**
 * Unified MCP Server Center: claude 侧的开关投影 —— 写 `~/.claude.json` 的
 * `projects.<absFolderPath>.disabledMcpServers`。
 *
 * 为什么是这个字段：它是**按名禁用、覆盖所有来源**（顶层 / 项目分桶 / `.mcp.json`）的，
 * 端到端实测过。`enabledMcpjsonServers` / `disabledMcpjsonServers` 不是开关，是
 * `.mcp.json` 的**信任决策**，catmax 只读不写。
 *
 * ⚠️ 三条安全约束，每条都是这个文件特有的：
 *
 * 1. **不做备份。** `.claude.json` 里有明文凭据（本机就有一个 Bearer token），
 *    `mode 0600`。复制一份出来就等于多了一处 catmax 没在管的密钥副本——备份的
 *    收益（能回滚一个布尔开关）远小于这个代价。
 * 2. **原子替换 + 保持 0600。** 直接覆写的话，进程在写一半时挂掉就把用户 86KB 的
 *    配置连同登录态一起废了。临时文件同目录 + rename，并在写入前就 chmod。
 * 3. **只改这一个键。** 读整份 JSON、改一处、写回去——`projects` 桶里还有会话历史、
 *    onboarding 状态等等一大堆东西，任何"顺手规整一下"都是在拿用户数据冒险。
 *
 * 还有一条不是安全但同样要紧的：**保持缩进风格**。实测用户的文件是 2 空格缩进的
 * 86KB；用 `JSON.stringify(x)` 压成一行会让整个文件面目全非（也让用户自己没法读），
 * 反过来把压缩的文件展开则会让它膨胀几倍。所以按原文探测后原样写回。
 */
import { existsSync, readFileSync } from 'node:fs'
import { chmod, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { logger } from './logger'
import { claudeJsonPath } from './mcp-roots'

const log = logger.domain('mcp-claude-writer')

/** `.claude.json` 的权限位。写完必须仍是它——里面有凭据。 */
const CLAUDE_JSON_MODE = 0o600

type JsonObject = Record<string, unknown>

/**
 * 探测原文的缩进，写回时沿用。
 *
 * 只区分「有缩进」和「压成一行」两种，不去还原具体几个空格——JSON.stringify 只支持
 * 统一缩进，猜得再细也还原不了。实测 claude 自己写的是 2 空格。
 */
function detectIndent(raw: string): number | undefined {
  return /^\{\s*\n\s+"/.test(raw) ? 2 : undefined
}

function asObject(value: unknown): JsonObject | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as JsonObject
}

/**
 * 原地更新 `projects.<folder>.disabledMcpServers`。
 *
 * @param disabledByFolder folderPath → 该项目下要禁用的 server 名（全集，不是增量）。
 *   给空数组表示「这个项目一个都不禁用」，会把该键删掉而不是写 `[]`——留一个空数组
 *   在用户配置里是噪音，而且会让人以为 catmax 在这儿存了什么东西。
 *
 * 文件不存在就不写：claude 自己会在首次运行时创建它，catmax 替它造一个只有
 * `projects` 的空壳，反而可能干扰它的 onboarding 判断。
 */
export async function writeClaudeDisabledServers(
  disabledByFolder: Map<string, string[]>,
): Promise<void> {
  if (disabledByFolder.size === 0) return
  const path = claudeJsonPath()
  if (!existsSync(path)) {
    log.info('.claude.json not found, skipping claude projection', path)
    return
  }

  // 解析不了就**什么都不做**。绝不能"重建一个干净的"——那会把用户的登录态和
  // 全部项目历史一次性抹掉，代价远大于一个开关没生效。
  const parsed = readClaudeJson(path)
  if (!parsed) return
  const { root, raw } = parsed

  const projects = asObject(root.projects) ?? {}
  let changed = false

  for (const [folder, names] of disabledByFolder) {
    const bucket = asObject(projects[folder])
    // 项目桶不存在就不创建：claude 会在第一次在该目录下运行时建。凭空造一个
    // 只有 disabledMcpServers 的桶是可以的，但那意味着往用户配置里加它没见过的项目。
    if (!bucket) {
      if (names.length > 0) {
        log.info('claude has no project bucket yet, disable not projected', folder)
      }
      continue
    }
    const current = Array.isArray(bucket.disabledMcpServers)
      ? (bucket.disabledMcpServers as unknown[]).filter((n): n is string => typeof n === 'string')
      : []
    const next = [...new Set(names)].sort()
    if (current.length === next.length && current.every((n, i) => n === next[i])) continue

    if (next.length === 0) delete bucket.disabledMcpServers
    else bucket.disabledMcpServers = next
    changed = true
  }

  if (!changed) return
  root.projects = projects

  const indent = detectIndent(raw)
  const serialized = `${JSON.stringify(root, null, indent)}\n`

  // 同目录临时文件 + rename：跨目录 rename 不保证原子，而且会丢 APFS 上的
  // 同卷保证。文件名带 pid，避免两个 catmax 实例互相踩。
  await atomicWrite(path, serialized)
  log.info('projected mcp disable state into .claude.json')
}

/**
 * 同目录临时文件 + rename。
 *
 * 跨目录 rename 不保证原子（也可能跨卷），所以必须同目录；文件名带 pid，避免两个
 * catmax 实例互相踩。显式 chmod 是因为 `writeFile` 的 mode 受 umask 影响，而这个文件
 * 里有凭据，不能指望默认值刚好对。
 */
async function atomicWrite(path: string, contents: string): Promise<void> {
  const tmp = join(dirname(path), `.claude.json.catmax-${process.pid}.tmp`)
  try {
    await writeFile(tmp, contents, { encoding: 'utf8', mode: CLAUDE_JSON_MODE })
    await chmod(tmp, CLAUDE_JSON_MODE)
    await rename(tmp, path)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

/** 读 + 解析，坏了就返回 null（调用方一律「什么都不做」，绝不重建）。 */
function readClaudeJson(path: string): { root: JsonObject; raw: string } | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8')
    const root = asObject(JSON.parse(raw))
    return root ? { root, raw } : null
  } catch (error) {
    log.warn('.claude.json unreadable or invalid, refusing to write', error)
    return null
  }
}

export interface ClaudeServerTarget {
  /** global = 顶层 mcpServers；project = projects.<folderPath>.mcpServers */
  scope: 'global' | 'project'
  folderPath?: string
}

/**
 * 写入 / 删除 `~/.claude.json` 里的一整条 MCP server 定义。
 *
 * ⚠️ **这会把配置里的凭据明文写进第二个文件**（设计文档 §9.2）。调用方必须先向
 * 用户明确告知写到了哪，不能当成静默操作——注入层之所以是默认，就是为了避开这件事。
 *
 * @param server 传 null 表示删除。
 * @returns 实际写入的文件路径；没写（文件不存在 / JSON 坏了 / 没变化）返回 null。
 */
export async function writeClaudeServer(
  name: string,
  server: Record<string, unknown> | null,
  target: ClaudeServerTarget,
): Promise<string | null> {
  const path = claudeJsonPath()
  const parsed = readClaudeJson(path)
  if (!parsed) {
    log.info('.claude.json not usable, skipping write', path)
    return null
  }
  const { root, raw } = parsed

  let bucket: JsonObject
  if (target.scope === 'global') {
    bucket = asObject(root.mcpServers) ?? {}
    root.mcpServers = bucket
  } else {
    if (!target.folderPath) return null
    const projects = asObject(root.projects) ?? {}
    root.projects = projects
    const project = asObject(projects[target.folderPath])
    // 项目桶不存在时不创建——同 writeClaudeDisabledServers 的理由：那等于往用户配置里
    // 加一个他没在 claude 里打开过的项目。
    if (!project) {
      log.info('claude has no project bucket, write skipped', target.folderPath)
      return null
    }
    bucket = asObject(project.mcpServers) ?? {}
    project.mcpServers = bucket
  }

  if (server === null) {
    if (!(name in bucket)) return null
    delete bucket[name]
  } else {
    bucket[name] = server
  }

  await atomicWrite(path, `${JSON.stringify(root, null, detectIndent(raw))}\n`)
  log.info(server === null ? 'removed' : 'wrote', 'mcp server in .claude.json:', name)
  return path
}
