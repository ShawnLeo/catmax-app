/**
 * codex item / event → 归一化 TurnEvent 转译层。
 *
 * 职责：
 * - 把 codex 的 commandExecution / fileChange / agentMessage / reasoning 等 item
 *   转成 TurnEvent（tool_call_started / text_delta 等）
 * - 评估 approval 的 riskLevel（assessRisk 提到 shared，跟 claude 复用）
 * - 不接触字节流（那是 protocol.ts 的事）
 */
import type {
  CodexActivity,
  CodexActivityContentBlock,
  CodexActivityStatus,
  CodexDiffStats,
  CodexFileChange,
  ContentBlock,
} from '@shared/backend/blocks'
import type { CodexItem } from '@shared/backend/schema'
import type { ApprovalRequest, ToolCallInfo, ToolOutput } from '@shared/backend/types'
import { v4PatchToCodexFileChanges } from '@shared/backend/v4-patch'

import { assessRisk } from '../shared/assess-risk'

// 重新导出——codex adapter 其他文件可能 import from './mapping'
export { assessRisk }

type CommandExecutionItem = Extract<CodexItem, { type: 'command_execution' }>
type FileChangeItem = Extract<CodexItem, { type: 'file_change' }>
type McpToolCallItem = Extract<CodexItem, { type: 'mcp_tool_call' }>

interface RawCommandAction {
  type?: string
  command?: string
  name?: string
  path?: string | null
  query?: string | null
}

type RawCodexItem = CodexItem & Record<string, unknown>

/** 把 codex item 转成 ToolCallInfo（用于 UI 展示） */
export function codexItemToToolCallInfo(item: CodexItem): ToolCallInfo | null {
  const type = normalizeItemType(item.type)
  switch (type) {
    case 'command_execution': {
      const cmd = (item as CommandExecutionItem).command
      return {
        kind: 'shell_command',
        title: cmd.slice(0, 80),
        detail: cmd,
      }
    }
    case 'file_change': {
      const fc = item as FileChangeItem
      const paths = fc.changes
        .map((c) => c.path)
        .slice(0, 5)
        .join(', ')
      const summary = `${fc.changes.length} file(s): ${paths}`
      // codex 的 change 自带标准 unified diff 文本（c.diff），结构化透传给前端 DiffView
      const unifiedDiff = fc.changes
        .filter((c) => c.diff)
        .map((c) => c.diff!)
        .join('\n')
      return {
        kind: 'file_edit',
        title: summary.slice(0, 80),
        // detail 保留作为 fallback（前端没有 edit 字段或解析失败时用）
        detail: fc.changes.map((c) => `--- ${c.path} (${c.kind}) ---\n${c.diff ?? ''}`).join('\n'),
        ...(unifiedDiff
          ? { edit: { type: 'unified_diff' as const, filePath: paths, diff: unifiedDiff } }
          : {}),
      }
    }
    case 'mcp_tool_call': {
      const mcp = item as McpToolCallItem
      return {
        kind: 'mcp',
        title: `${mcp.server}/${mcp.tool}`,
        ...(mcp.arguments !== undefined ? { detail: JSON.stringify(mcp.arguments, null, 2) } : {}),
      }
    }
    case 'custom_tool_call': {
      // 现代 codex 的 apply_patch：把整段 V4 patch 作为 unified_diff edit 喂给 DiffView
      // （DiffView 内部会按 filePath 切分到单文件渲染）。
      const raw = item as RawCodexItem
      if (raw.name !== 'apply_patch') return null
      const input = typeof raw.input === 'string' ? raw.input : ''
      if (!input) return null
      const changes = v4PatchToCodexFileChanges(input)
      const paths = changes
        .map((c) => c.path)
        .slice(0, 5)
        .join(', ')
      const summary = `${changes.length} file(s): ${paths}`
      return {
        kind: 'file_edit',
        title: summary.slice(0, 80),
        detail: input,
        edit: { type: 'unified_diff', filePath: paths, diff: input },
      }
    }
    // 其他 item 类型（user_message、agent_message、reasoning）不算 tool call
    default:
      return null
  }
}

export function normalizeItemType(type: string): string {
  return (
    {
      userMessage: 'user_message',
      agentMessage: 'agent_message',
      commandExecution: 'command_execution',
      fileChange: 'file_change',
      mcpToolCall: 'mcp_tool_call',
      dynamicToolCall: 'dynamic_tool_call',
      collabToolCall: 'collab_tool_call',
      webSearch: 'web_search',
      imageView: 'image_view',
      contextCompaction: 'context_compaction',
    }[type] ?? type
  )
}

/** Codex items that deserve first-class chat blocks instead of being silently discarded. */
export function codexItemToContentBlock(item: CodexItem): ContentBlock | null {
  const activityBlock = codexItemToActivityBlock(item)
  if (activityBlock) return activityBlock

  const raw = item as RawCodexItem
  const type = normalizeItemType(item.type)
  if (type === 'agent_message') {
    const phase = raw.phase === 'commentary' || raw.phase === 'final_answer' ? raw.phase : undefined
    return {
      id: `${item.id}-text`,
      type: 'text',
      text: String(raw.text ?? ''),
      ...(phase ? { phase } : {}),
    }
  }
  if (type === 'plan') {
    return { id: item.id, type: 'plan', text: String(raw.text ?? '') }
  }
  if (type === 'context_compaction') {
    return { id: item.id, type: 'compact_divider' }
  }
  if (type === 'web_search') {
    const query = String(raw.query ?? '')
    return {
      id: item.id,
      type: 'tool_call',
      info: {
        kind: 'web',
        title: query ? `Web search: ${query}` : 'Web search',
        web: { type: 'search', query },
      },
      status: 'completed',
    }
  }
  if (type === 'image_view') {
    const path = String(raw.path ?? '')
    return {
      id: item.id,
      type: 'tool_call',
      info: { kind: 'file_read', title: `View image: ${path}`, detail: path },
      status: 'completed',
    }
  }
  if (type === 'dynamic_tool_call' || type === 'collab_tool_call') {
    const tool = String(raw.tool ?? type)
    const detail = raw.arguments ?? raw.prompt
    return {
      id: item.id,
      type: 'tool_call',
      info: {
        kind: type === 'collab_tool_call' ? 'task' : 'other',
        title: tool,
        ...(detail !== undefined ? { detail: JSON.stringify(detail, null, 2) } : {}),
      },
      status: raw.status === 'inProgress' ? 'running' : 'completed',
    }
  }
  return null
}

/** 把 Codex 的可观察工作 item 转成极简活动列表块。 */
export function codexItemToActivityBlock(
  item: CodexItem,
  options: { defaultCollapsed?: boolean } = {},
): CodexActivityContentBlock | null {
  const activities = codexItemToActivities(item)
  if (activities.length === 0) return null
  const durationMs = activities.reduce((total, activity) => total + (activity.durationMs ?? 0), 0)
  return {
    id: item.id,
    type: 'codex_activity',
    status: aggregateActivityStatus(activities),
    activities,
    ...(options.defaultCollapsed !== undefined
      ? { defaultCollapsed: options.defaultCollapsed }
      : {}),
    ...(durationMs > 0 ? { durationMs } : {}),
  }
}

/** 使用 app-server 的 commandActions，而不是在 renderer 猜命令语义。 */
export function codexItemToActivities(item: CodexItem): CodexActivity[] {
  const raw = item as RawCodexItem
  const type = normalizeItemType(item.type)
  const status = normalizeActivityStatus(raw.status)
  const durationMs = numberOrUndefined(raw.durationMs)

  if (type === 'command_execution') {
    const command = String(raw.command ?? '')
    const cwd = stringOrUndefined(raw.cwd)
    const output = stringOrUndefined(raw.aggregatedOutput)
    const actions = Array.isArray(raw.commandActions)
      ? (raw.commandActions as RawCommandAction[])
      : []
    if (actions.length === 0) {
      return [
        {
          id: item.id,
          kind: 'command',
          command,
          status,
          ...(cwd ? { cwd } : {}),
          ...(output !== undefined ? { output } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        },
      ]
    }
    return actions.map((action, index) =>
      commandActionToActivity(action, {
        // 第一条沿用 item id，确保旧版本 item/started 缺 commandActions、但
        // item/completed 补齐 actions 时仍能原位替换，而不是生成重复命令。
        id: index === 0 ? item.id : `${item.id}-${index}`,
        parentCommand: command,
        status,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      }),
    )
  }

  if (type === 'file_change') {
    const changes = Array.isArray(raw.changes)
      ? raw.changes.map((change) => normalizeFileChange(change))
      : []
    return [
      {
        id: item.id,
        kind: 'file_change',
        status,
        changes,
        ...(durationMs !== undefined ? { durationMs } : {}),
      },
    ]
  }

  // V4 Patch: 现代 codex 用 apply_patch 工具（custom_tool_call item）改文件。
  // 把 input 里的 V4 patch 解析成 CodexFileChange[]，伪装成 file_change 活动，
  // 这样 CodexChangesCard / 审查 tab / DiffView 的 V4 fallback 都能正常工作。
  if (type === 'custom_tool_call' && raw.name === 'apply_patch') {
    const input = typeof raw.input === 'string' ? raw.input : ''
    const changes = v4PatchToCodexFileChanges(input)
    if (changes.length === 0) return []
    return [
      {
        id: item.id,
        kind: 'file_change',
        status,
        changes,
        ...(durationMs !== undefined ? { durationMs } : {}),
      },
    ]
  }

  if (type === 'mcp_tool_call') {
    const title = [raw.server, raw.tool].filter(Boolean).map(String).join('/')
    return [
      {
        id: item.id,
        kind: 'mcp',
        title: title || 'MCP',
        status,
        ...(raw.arguments !== undefined ? { detail: JSON.stringify(raw.arguments, null, 2) } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      },
    ]
  }

  if (type === 'dynamic_tool_call') {
    return [
      {
        id: item.id,
        kind: 'dynamic_tool',
        title: String(raw.tool ?? 'Tool'),
        status,
        ...(raw.arguments !== undefined ? { detail: JSON.stringify(raw.arguments, null, 2) } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      },
    ]
  }

  if (type === 'collab_tool_call') {
    return [
      {
        id: item.id,
        kind: 'collab_tool',
        title: String(raw.tool ?? 'Subagent'),
        status,
        ...(raw.prompt !== undefined ? { detail: String(raw.prompt) } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      },
    ]
  }

  if (type === 'web_search') {
    const query = String(raw.query ?? '')
    return [
      {
        id: item.id,
        kind: 'web_search',
        title: query || 'Web search',
        status: 'completed',
      },
    ]
  }

  if (type === 'image_view') {
    return [
      {
        id: item.id,
        kind: 'image_view',
        title: String(raw.path ?? ''),
        status: 'completed',
      },
    ]
  }

  return []
}

export function diffStats(diff: string | undefined): CodexDiffStats {
  if (!diff) return { additions: 0, deletions: 0 }
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++
    if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  return { additions, deletions }
}

export function aggregateActivityStatus(activities: CodexActivity[]): CodexActivityStatus {
  if (activities.some((activity) => activity.status === 'running')) return 'running'
  if (activities.some((activity) => activity.status === 'failed')) return 'failed'
  return 'completed'
}

function commandActionToActivity(
  action: RawCommandAction,
  context: {
    id: string
    parentCommand: string
    cwd?: string
    output?: string
    status: CodexActivityStatus
    durationMs?: number
  },
): CodexActivity {
  const command = action.command ?? context.parentCommand
  const common = {
    id: context.id,
    command,
    status: context.status,
    ...(context.durationMs !== undefined ? { durationMs: context.durationMs } : {}),
  }
  switch (action.type) {
    case 'read':
      return {
        ...common,
        kind: 'file_read',
        path: action.path ?? action.name ?? '',
        ...(action.name ? { name: action.name } : {}),
      }
    case 'listFiles':
      return {
        ...common,
        kind: 'file_list',
        ...(action.path ? { path: action.path } : {}),
      }
    case 'search':
      return {
        ...common,
        kind: 'search',
        ...(action.query ? { query: action.query } : {}),
        ...(action.path ? { path: action.path } : {}),
      }
    default:
      return {
        ...common,
        kind: 'command',
        ...(context.cwd ? { cwd: context.cwd } : {}),
        ...(context.output !== undefined ? { output: context.output } : {}),
      }
  }
}

function normalizeFileChange(value: unknown): CodexFileChange {
  const change =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const diff = stringOrUndefined(change.diff)
  const rawKind = change.kind
  let kind: CodexFileChange['kind'] = 'unknown'
  let movePath: string | undefined
  if (typeof rawKind === 'string') {
    if (rawKind === 'add' || rawKind === 'delete' || rawKind === 'update') kind = rawKind
    if (rawKind === 'edit') kind = 'update'
  } else if (typeof rawKind === 'object' && rawKind !== null) {
    const kindObject = rawKind as Record<string, unknown>
    const type = kindObject.type
    if (type === 'add' || type === 'delete' || type === 'update') kind = type
    movePath = stringOrUndefined(kindObject.move_path)
  }
  return {
    path: String(change.path ?? ''),
    kind,
    ...(movePath ? { movePath } : {}),
    ...(diff !== undefined ? { diff } : {}),
    stats: diffStats(diff),
  }
}

function normalizeActivityStatus(value: unknown): CodexActivityStatus {
  if (value === 'inProgress' || value === 'in_progress' || value === 'running') return 'running'
  if (value === 'failed' || value === 'declined' || value === 'cancelled') return 'failed'
  return 'completed'
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

/** 把 codex commandExecution 完成态转成 ToolOutput */
export function codexCommandToOutput(item: CommandExecutionItem): ToolOutput {
  // 优先用 exitCode 判断成败（exit 0 = ok）；exitCode 缺失时回退到 status。
  // codex 的 status:'completed' 表示命令跑完了，不代表 exit 0。
  const exitCode = typeof item.exitCode === 'number' ? item.exitCode : undefined
  const ok = exitCode !== undefined ? exitCode === 0 : item.status === 'completed'
  const summary =
    exitCode !== undefined
      ? exitCode === 0
        ? `exit 0 (${item.durationMs ?? 0}ms)`
        : `exit ${exitCode}`
      : item.status

  return {
    ok,
    summary,
    ...(typeof item.aggregatedOutput === 'string' ? { output: item.aggregatedOutput } : {}),
  }
}

/** 把 codex file_change 完成态转成 ToolOutput */
export function codexFileChangeToOutput(item: FileChangeItem): ToolOutput {
  const ok = item.status === 'completed'
  return {
    ok,
    summary: ok ? `${item.changes.length} file(s) edited` : `failed: ${item.status}`,
    output: item.changes.map((c) => `--- ${c.path} (${c.kind}) ---\n${c.diff ?? ''}`).join('\n'),
  }
}

/** 把 codex approval 请求参数转成 ApprovalRequest */
export function codexApprovalToRequest(
  kind: ApprovalRequest['kind'],
  command: string | undefined,
  cwd: string | undefined,
  reason: string | undefined,
  changes?: { path: string; kind: string; diff?: string }[],
): ApprovalRequest {
  if (kind === 'shell_command') {
    const cmd = command ?? '(unknown command)'
    return {
      kind,
      title: cmd.slice(0, 100),
      detail: `$ ${cmd}${cwd ? `\n(cwd: ${cwd})` : ''}${reason ? `\n\n${reason}` : ''}`,
      riskLevel: assessRisk(kind, cmd),
    }
  }
  if (kind === 'file_edit') {
    const paths =
      changes
        ?.map((c) => c.path)
        .slice(0, 5)
        .join(', ') ?? '(no paths)'
    return {
      kind,
      title: `Edit ${changes?.length ?? 0} file(s)`,
      detail:
        changes?.map((c) => `--- ${c.path} (${c.kind}) ---\n${c.diff ?? ''}`).join('\n') ?? '',
      riskLevel: assessRisk(kind, paths),
    }
  }
  return {
    kind,
    title: reason ?? 'Unknown MCP call',
    detail: reason ?? '',
    riskLevel: 'medium',
  }
}

/** 由 itemId 生成稳定的 itemId（codex item 已带 id，直接用） */
export function ensureItemId(codexItemId: string | undefined, fallback: string): string {
  return codexItemId ?? fallback
}
