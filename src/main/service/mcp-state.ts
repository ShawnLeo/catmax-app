/**
 * Unified MCP Server Center: 「哪些 server 被用户关掉了」这份状态，catmax 自己拥有。
 *
 * **按名存**（与 skill-state 一致）——两端的开关机制都是纯按名索引的：
 * codex 是 `[mcp_servers.<name>].enabled`，claude 是 `disabledMcpServers: string[]`。
 * 没有任何一端支持按路径选择，所以这里也不该假装能按路径。
 *
 * **但比 skill-state 多一层 global/project 分桶**，这是与技能中心的真实差异：
 * claude 的 `disabledMcpServers` 本身就住在 `projects.<abs>` 桶里、天然 per-project，
 * codex 的项目层也是 per-repo。同名 server 在不同项目可能是完全不同的配置
 * （团队共享的 `.mcp.json` 尤其如此），混作一谈会让「关掉项目 A 的 weather」
 * 误伤项目 B——技能那边不存在这个问题，因为技能名在后端就是一个全局名字空间。
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { BackendId } from '@shared/constants'
import type { McpScope } from '@shared/mcp/types'
import { app } from 'electron'

import { logger } from './logger'

const log = logger.domain('mcp-state')

const STATE_NAME = 'mcp-state.json'

export interface McpState {
  /** 全局桶：被关掉的 server 名，影响所有会话。 */
  globalDisabled: string[]
  /** 项目桶：folderPath → 被关掉的 server 名。 */
  projectDisabled: Record<string, string[]>
  /**
   * 「在 catmax 里补给这个后端」的 server 名（注入层，见 mcp-inject.ts）。
   *
   * 存名字而不是存配置副本：配置的真相始终在源后端的文件里，存副本就等于又造了
   * 一份会漂移的拷贝——而且那份拷贝里会带着明文密钥，落进 catmax 自己的
   * `mcp-state.json`（0644）。存名字则每次注入时现读现用，密钥一步也不落新盘。
   */
  injected: Record<BackendId, string[]>
}

/**
 * 每次都造一个新对象。
 *
 * ⚠️ 不要退回成 `const EMPTY = {...}` + `{ ...EMPTY }`：那是**浅拷贝**，
 * `projectDisabled` 会与模块级常量共享同一个引用，而 setMcpEnabled 是就地写
 * （`state.projectDisabled[folder] = [...]`）——一次调用就会把这个"空状态"永久污染，
 * 此后任何一次「文件不存在」或「文件损坏」的读取都会继承上一次的禁用项。
 * 这条被 mcp-state 的测试钉住了。
 */
function emptyState(): McpState {
  return { globalDisabled: [], projectDisabled: {}, injected: { codex: [], claude: [] } }
}

function statePath(): string {
  try {
    return join(app.getPath('userData'), STATE_NAME)
  } catch {
    // 非 Electron 环境（vitest）下的回退，与 skill-state 同样处理。
    return join(process.env.HOME ?? process.cwd(), '.catmax', STATE_NAME)
  }
}

function sanitizeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((n): n is string => typeof n === 'string')
}

export function readMcpState(): McpState {
  const path = statePath()
  if (!existsSync(path)) return emptyState()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<McpState>
    const projectDisabled: Record<string, string[]> = {}
    if (parsed.projectDisabled && typeof parsed.projectDisabled === 'object') {
      for (const [folder, names] of Object.entries(parsed.projectDisabled)) {
        const list = sanitizeNames(names)
        if (list.length > 0) projectDisabled[folder] = list
      }
    }
    const injected: Record<BackendId, string[]> = { codex: [], claude: [] }
    if (parsed.injected && typeof parsed.injected === 'object') {
      for (const [backend, names] of Object.entries(parsed.injected)) {
        injected[backend] = sanitizeNames(names)
      }
    }
    return { globalDisabled: sanitizeNames(parsed.globalDisabled), projectDisabled, injected }
  } catch (error) {
    // 状态文件坏了就当「全部启用」——比让整个 MCP 列表打不开好，而且方向是安全的：
    // 用户会看到一个本该关闭的 server 还开着（可见、可再关），而不是反过来。
    log.warn('mcp state unreadable, treating all as enabled', error)
    return emptyState()
  }
}

export async function writeMcpState(state: McpState): Promise<void> {
  const path = statePath()
  await mkdir(dirname(path), { recursive: true })
  const normalized: McpState = {
    globalDisabled: [...new Set(state.globalDisabled)].sort(),
    projectDisabled: Object.fromEntries(
      Object.entries(state.projectDisabled)
        .map(([folder, names]) => [folder, [...new Set(names)].sort()] as const)
        .filter(([, names]) => names.length > 0)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    injected: Object.fromEntries(
      Object.entries(state.injected).map(
        ([backend, names]) => [backend, [...new Set(names)].sort()] as const,
      ),
    ),
  }
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
}

/**
 * 某个 server 在给定作用域下是否被 catmax 关掉。
 *
 * 合并规则：**全局桶影响所有项目，项目桶只影响自己**。所以一个 project scope 的
 * server 只要在任一侧命中就算关闭——这与 UI 上「关掉它」的直觉一致（用户不会预期
 * 关了全局还要再关一次项目）。
 */
export function isDisabled(
  state: McpState,
  name: string,
  scope: McpScope,
  folderPath: string | null,
): boolean {
  if (state.globalDisabled.includes(name)) return true
  if (scope === 'project' && folderPath) {
    return (state.projectDisabled[folderPath] ?? []).includes(name)
  }
  return false
}

/**
 * 写入开关，返回新状态供调用方投影到两个后端。
 *
 * scope 决定写哪个桶：global 写全局桶，project 写对应 folderPath 的桶。
 *
 * 企业管控层来的 server（entry.managed）不该走到这里——调用方按 managed 先拦。
 * 这里不再自己判：只读性是 per-location 的，state 只认名字和桶。
 */
export async function setMcpEnabled(
  name: string,
  scope: McpScope,
  folderPath: string | null,
  enabled: boolean,
): Promise<McpState> {
  const state = readMcpState()

  if (scope === 'project' && folderPath) {
    const current = new Set(state.projectDisabled[folderPath] ?? [])
    if (enabled) current.delete(name)
    else current.add(name)
    state.projectDisabled[folderPath] = [...current]
  } else {
    const current = new Set(state.globalDisabled)
    if (enabled) current.delete(name)
    else current.add(name)
    state.globalDisabled = [...current]
  }

  // 开启一个项目级 server 时，全局桶里的同名禁用也要撤掉——否则用户点了"开"
  // 却发现它还是关的（被全局桶挡着），这正是最难自查的那类"界面撒谎"。
  if (enabled && scope === 'project') {
    state.globalDisabled = state.globalDisabled.filter((n) => n !== name)
  }

  await writeMcpState(state)
  return state
}

/**
 * claude 侧投影：某个工作区文件夹要写进 `projects.<folder>.disabledMcpServers` 的名单。
 *
 * 全局桶也要算进去——claude **没有「全局禁用」的位置**，只有 per-project 的
 * `disabledMcpServers`。所以 catmax 的全局禁用只能展开成「当前工作区每个文件夹
 * 都写一遍」。这是一个真实的语义损耗，UI 必须说明：换个新项目时该 server 会"复活"。
 */
/**
 * 记下 / 取消「把这个 server 补给该后端」。
 *
 * 只存名字，不存配置——配置的真相在源后端的文件里，存副本既会漂移，又会把明文密钥
 * 落进 catmax 自己的状态文件。
 */
export async function setMcpInjected(
  name: string,
  target: BackendId,
  injected: boolean,
): Promise<McpState> {
  const state = readMcpState()
  const current = new Set(state.injected[target] ?? [])
  if (injected) current.add(name)
  else current.delete(name)
  state.injected[target] = [...current]
  await writeMcpState(state)
  return state
}

export function claudeDisabledNamesFor(state: McpState, folderPath: string): string[] {
  const merged = new Set([...state.globalDisabled, ...(state.projectDisabled[folderPath] ?? [])])
  return [...merged].sort()
}
