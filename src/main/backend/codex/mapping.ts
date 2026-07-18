/**
 * codex item / event → 归一化 TurnEvent 转译层。
 *
 * 职责：
 * - 把 codex 的 commandExecution / fileChange / agentMessage / reasoning 等 item
 *   转成 TurnEvent（tool_call_started / text_delta 等）
 * - 评估 approval 的 riskLevel
 * - 不接触字节流（那是 protocol.ts 的事）
 */
import type { CodexItem } from '@shared/backend/schema'
import type { ApprovalRequest, ToolCallInfo, ToolOutput } from '@shared/backend/types'

/** 评估命令的风险等级（用于 approval UI 默认按钮焦点） */
export function assessRisk(
  kind: ApprovalRequest['kind'],
  detail: string,
): 'low' | 'medium' | 'high' {
  if (kind === 'shell_command') {
    if (
      /^(git status|git log|git diff|git branch|ls|ll|cat|pwd|echo|grep|find|rg|fd|head|tail|wc|which)\b/.test(
        detail,
      )
    ) {
      return 'low'
    }
    if (
      /\b(rm|git push --force|git push -f|git reset --hard|npm publish|sudo|chmod|chown|dd|mkfs|curl|wget)\b/.test(
        detail,
      )
    ) {
      return 'high'
    }
    return 'medium'
  }
  if (kind === 'file_edit') return 'medium'
  if (kind === 'mcp') return 'medium'
  return 'medium'
}

type CommandExecutionItem = Extract<CodexItem, { type: 'command_execution' }>
type FileChangeItem = Extract<CodexItem, { type: 'file_change' }>
type McpToolCallItem = Extract<CodexItem, { type: 'mcp_tool_call' }>

/** 把 codex item 转成 ToolCallInfo（用于 UI 展示） */
export function codexItemToToolCallInfo(item: CodexItem): ToolCallInfo | null {
  switch (item.type) {
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
      return {
        kind: 'file_edit',
        title: summary.slice(0, 80),
        detail: fc.changes.map((c) => `--- ${c.path} (${c.kind}) ---\n${c.diff ?? ''}`).join('\n'),
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
    // 其他 item 类型（user_message、agent_message、reasoning）不算 tool call
    default:
      return null
  }
}

/** 把 codex commandExecution 完成态转成 ToolOutput */
export function codexCommandToOutput(item: CommandExecutionItem): ToolOutput {
  // 优先用 exitCode 判断成败（exit 0 = ok）；exitCode 缺失时回退到 status。
  // codex 的 status:'completed' 表示命令跑完了，不代表 exit 0。
  const ok = item.exitCode !== undefined ? item.exitCode === 0 : item.status === 'completed'
  const summary =
    item.exitCode !== undefined
      ? item.exitCode === 0
        ? `exit 0 (${item.durationMs ?? 0}ms)`
        : `exit ${item.exitCode}`
      : item.status

  return {
    ok,
    summary,
    ...(item.aggregatedOutput !== undefined ? { output: item.aggregatedOutput } : {}),
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
