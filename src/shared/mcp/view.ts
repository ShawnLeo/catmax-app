/**
 * Unified MCP Server Center: 从 locations[] 派生展示信息的纯函数。
 *
 * 放 shared 而不是 renderer：设置页的筛选、McpRow 的摘要、后续 popover 都要用同一套
 * 判据，抄三份迟早出现「筛选说是 stdio、行里显示 URL」这种自相矛盾。
 *
 * 全部只吃 McpLocation —— 也就是**已脱敏**的配置。这里不碰、也不需要真密钥。
 */
import type { BackendId } from '../constants'

import { MCP_ROOT_META, type McpEntry, type McpLocation } from './types'

/**
 * 摘要显示该取哪一处身影：**优先取用户自己能改的那一份**。
 *
 * 不能无脑取 locations[0]。合并了系统层之后，locations[0] 可能是
 * `/etc/codex/config.toml` 里那份——而 codex 的用户层是覆盖它的，
 * 拿被覆盖的那份做摘要等于告诉用户一个不生效的命令行。
 *
 * 为什么不取「优先级最高的那一层」：claude 的 managed 与用户层谁压谁没验证过
 * （见 MCP_ROOT_ORDER 的注释）。而「用户能改的那一份」无论优先级方向如何都是
 * 用户唯一能动手的东西，用它做摘要不会把人引到一个改了也没用的地方。
 */
export function pickDisplayLocation(locations: McpLocation[]): McpLocation | null {
  return locations.find((l) => MCP_ROOT_META[l.kind].writable) ?? locations[0] ?? null
}

/** 一行命令行 / URL。列表摘要与搜索命中都用它，保证搜得到的就是看得见的。 */
export function configSummary(location: McpLocation | null | undefined): string {
  const config = location?.config
  if (!config) return ''
  if (config.transport === 'stdio') {
    return [config.command, ...(config.args ?? [])].filter(Boolean).join(' ')
  }
  return config.url ?? ''
}

/**
 * 跨后端配置漂移。
 *
 * ⚠️ 只比**后端之间**，不比同一后端的层与层之间。系统层和用户层写得不一样是
 * codex 配置栈的正常用法（用户层就是用来覆盖的），报成「两端不一致」是误报。
 * 真正值得提醒的是 codex 那份和 claude 那份已经各自漂移——MCP 没有软链可依，
 * 两边是独立副本，这种漂移一定会发生。
 */
export function hasCrossBackendDrift(entry: McpEntry): boolean {
  const byBackend = new Map<BackendId, McpLocation[]>()
  for (const location of entry.locations) {
    for (const backend of MCP_ROOT_META[location.kind].backends) {
      const bucket = byBackend.get(backend)
      if (bucket) bucket.push(location)
      else byBackend.set(backend, [location])
    }
  }
  if (byBackend.size < 2) return false
  const summaries = new Set(
    [...byBackend.values()].map((locations) => configSummary(pickDisplayLocation(locations))),
  )
  return summaries.size > 1
}
