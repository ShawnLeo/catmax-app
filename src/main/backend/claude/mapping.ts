/**
 * Claude 工具调用 + 权限请求的共享映射层。
 *
 * 历史背景：本文件原是 CLI stream-json → TurnEvent 的完整转译层。
 * 迁移到 Agent SDK 后，SDK 消息 → TurnEvent 的转译移到了 sdk-mapping.ts。
 * 本文件只保留仍被复用的纯函数：
 * - toolUseToInfo：tool_use 内容块 → ToolCallInfo（sdk-mapping + history-mapping 复用）
 * - toolResultToOutput：tool_result → ToolOutput（sdk-mapping + history-mapping 复用）
 * - toolUseResultToStats：Task 子 Agent 统计 → ToolTaskStats（sdk-mapping + history-mapping 复用）
 * - claudePermissionToApprovalRequest：权限请求 → ApprovalRequest（adapter 的 canUseTool 回调用）
 *
 * 已删除（迁移到 SDK 后不再需要，由 sdk-mapping.ts 替代）：
 * - assistantToEvents / userToolResultToEvents / resultToEvent / StreamEventAggregator
 */
import type { ToolResultContent, ToolUseContent } from '@shared/backend/claude-schema'
import type {
  ToolCallInfo,
  ToolOutput,
  ToolTaskStats,
  ApprovalRequest,
} from '@shared/backend/types'

import { assessRisk } from '../shared/assess-risk'

/** 把 claude 的 tool_use 映射到 ToolCallInfo */
export function toolUseToInfo(block: ToolUseContent): ToolCallInfo {
  const input = block.input as Record<string, unknown> | undefined
  switch (block.name) {
    case 'Bash':
      return {
        kind: 'shell_command',
        title: typeof input?.command === 'string' ? input.command.slice(0, 80) : '(empty command)',
        ...(typeof input?.command === 'string' ? { detail: input.command } : {}),
      }

    case 'Edit':
      return {
        kind: 'file_edit',
        title: typeof input?.file_path === 'string' ? input.file_path : '(unknown file)',
        edit: {
          type: 'string_replace',
          filePath: typeof input?.file_path === 'string' ? input.file_path : '',
          oldString: typeof input?.old_string === 'string' ? input.old_string : '',
          newString: typeof input?.new_string === 'string' ? input.new_string : '',
        },
      }

    case 'MultiEdit': {
      const filePath = typeof input?.file_path === 'string' ? input.file_path : ''
      const editsRaw = Array.isArray(input?.edits) ? input.edits : []
      const edits = editsRaw
        .map((e: unknown) => {
          if (typeof e !== 'object' || e === null) return null
          const eo = e as Record<string, unknown>
          return {
            oldString: typeof eo.old_string === 'string' ? eo.old_string : '',
            newString: typeof eo.new_string === 'string' ? eo.new_string : '',
          }
        })
        .filter((e): e is { oldString: string; newString: string } => e !== null)
      return {
        kind: 'file_edit',
        title: filePath,
        edit: {
          type: 'string_replace',
          filePath,
          oldString: edits[0]?.oldString ?? '',
          newString: edits[0]?.newString ?? '',
          edits,
        },
      }
    }

    case 'Write':
      return {
        kind: 'file_edit',
        title: typeof input?.file_path === 'string' ? input.file_path : '(unknown file)',
        edit: {
          type: 'full_content',
          filePath: typeof input?.file_path === 'string' ? input.file_path : '',
          content: typeof input?.content === 'string' ? input.content : '',
        },
      }

    case 'NotebookEdit':
      return {
        kind: 'file_edit',
        title:
          typeof input?.notebook_path === 'string' ? input.notebook_path : '(unknown notebook)',
        edit: {
          type: 'full_content',
          filePath: typeof input?.notebook_path === 'string' ? input.notebook_path : '',
          content: typeof input?.new_source === 'string' ? input.new_source : '',
        },
      }

    case 'NotebookRead':
    case 'Read':
    case 'Glob':
    case 'Grep': {
      const path =
        typeof input?.file_path === 'string'
          ? input.file_path
          : typeof input?.pattern === 'string'
            ? input.pattern
            : typeof input?.path === 'string'
              ? input.path
              : '(unknown)'
      // title 加工具名前缀（"Read: /path"）——前端靠前缀区分渲染策略：
      //   - Read / NotebookRead → ToolCallInline（单行无边框，点开文件预览）
      //   - Glob / Grep → ToolCallCard（卡片，可展开看匹配结果）
      //   不加前缀会让 Read 误走卡片、且 typeName 显示为路径首段而非工具名。
      const prefix = block.name === 'Glob' ? 'Glob' : block.name === 'Grep' ? 'Grep' : 'Read'
      return {
        kind: 'file_read',
        title: `${prefix}: ${path}`,
      }
    }

    case 'WebSearch':
      return {
        kind: 'web',
        title: typeof input?.query === 'string' ? input.query.slice(0, 80) : 'web search',
        web: {
          type: 'search',
          query: typeof input?.query === 'string' ? input.query : '',
          ...(Array.isArray(input?.allowedDomains)
            ? { allowedDomains: input.allowedDomains as string[] }
            : {}),
          ...(Array.isArray(input?.blockedDomains)
            ? { blockedDomains: input.blockedDomains as string[] }
            : {}),
        },
      }

    case 'WebFetch':
      return {
        kind: 'web',
        title: typeof input?.url === 'string' ? input.url.slice(0, 80) : 'web fetch',
        web: {
          type: 'fetch',
          query: typeof input?.url === 'string' ? input.url : '',
          ...(typeof input?.prompt === 'string' ? { prompt: input.prompt } : {}),
        },
      }

    case 'Task':
      return {
        kind: 'task',
        title:
          typeof input?.description === 'string'
            ? input.description.slice(0, 80)
            : 'sub-agent task',
        task: {
          description: typeof input?.description === 'string' ? input.description : '',
          prompt: typeof input?.prompt === 'string' ? input.prompt : '',
        },
      }

    case 'EnterPlanMode':
      return {
        kind: 'control',
        title: 'Enter Plan Mode',
        control: { type: 'enter_plan_mode' },
      }

    case 'ExitPlanMode':
      return {
        kind: 'control',
        title: 'Exit Plan Mode',
        control: {
          type: 'exit_plan_mode',
          ...(typeof input?.plan === 'string' ? { plan: input.plan } : {}),
        },
      }

    case 'TodoWrite': {
      const todosRaw = Array.isArray(input?.todos) ? input.todos : []
      const todos = todosRaw
        .map((t: unknown) => {
          if (typeof t !== 'object' || t === null) return null
          const to = t as Record<string, unknown>
          const rawStatus = typeof to.status === 'string' ? to.status : 'pending'
          // claude 的 status 可能是 pending/in_progress/completed，防御性归一
          const status: 'pending' | 'in_progress' | 'completed' =
            rawStatus === 'in_progress' || rawStatus === 'completed' ? rawStatus : 'pending'
          return {
            content: typeof to.content === 'string' ? to.content : '',
            status,
            ...(typeof to.activeForm === 'string' ? { activeForm: to.activeForm } : {}),
          }
        })
        .filter(
          (
            t,
          ): t is {
            content: string
            status: 'pending' | 'in_progress' | 'completed'
            activeForm?: string
          } => t !== null,
        )
      return {
        kind: 'control',
        title: 'Update Todos',
        control: { type: 'todo_write', todos },
      }
    }

    default:
      if (block.name.startsWith('mcp__')) {
        return {
          kind: 'mcp',
          title: block.name,
        }
      }
      return {
        kind: 'other',
        title: block.name,
      }
  }
}

/** 把 claude 的 tool_result 内容块映射到 ToolOutput */
export function toolResultToOutput(block: ToolResultContent): ToolOutput {
  const isError = block.is_error === true
  let output: string | undefined
  if (typeof block.content === 'string') {
    output = block.content
  } else if (Array.isArray(block.content)) {
    // content 可能是 [{type: 'text', text: '...'}]
    output = block.content
      .map((c: unknown) =>
        typeof c === 'object' && c !== null && 'text' in c
          ? String((c as { text: unknown }).text)
          : String(c),
      )
      .join('\n')
  }

  return {
    ok: !isError,
    summary: isError ? 'failed' : 'completed',
    ...(output !== undefined ? { output } : {}),
  }
}

/**
 * 把 tool_use_result（Task 完成时 user 消息的顶层字段）转成 ToolTaskStats。
 *
 * 非 Task 工具不带这个字段，返回 undefined。
 * 字段全是 optional--claude CLI 版本不同可能缺字段，防御性提取。
 */
export function toolUseResultToStats(tur: unknown): ToolTaskStats | undefined {
  if (tur === null || typeof tur !== 'object') return undefined
  const r = tur as Record<string, unknown>
  const stats = r.toolStats
  return {
    ...(typeof r.agentId === 'string' ? { agentId: r.agentId } : {}),
    ...(typeof r.totalDurationMs === 'number' ? { totalDurationMs: r.totalDurationMs } : {}),
    ...(typeof r.totalTokens === 'number' ? { totalTokens: r.totalTokens } : {}),
    ...(typeof r.totalToolUseCount === 'number' ? { totalToolUseCount: r.totalToolUseCount } : {}),
    ...(typeof r.agentType === 'string' ? { agentType: r.agentType } : {}),
    ...(stats !== null && typeof stats === 'object'
      ? {
          toolStats: {
            ...(typeof (stats as Record<string, unknown>).readCount === 'number'
              ? { readCount: (stats as Record<string, unknown>).readCount as number }
              : {}),
            ...(typeof (stats as Record<string, unknown>).searchCount === 'number'
              ? { searchCount: (stats as Record<string, unknown>).searchCount as number }
              : {}),
            ...(typeof (stats as Record<string, unknown>).bashCount === 'number'
              ? { bashCount: (stats as Record<string, unknown>).bashCount as number }
              : {}),
            ...(typeof (stats as Record<string, unknown>).editFileCount === 'number'
              ? { editFileCount: (stats as Record<string, unknown>).editFileCount as number }
              : {}),
            ...(typeof (stats as Record<string, unknown>).linesAdded === 'number'
              ? { linesAdded: (stats as Record<string, unknown>).linesAdded as number }
              : {}),
            ...(typeof (stats as Record<string, unknown>).linesRemoved === 'number'
              ? { linesRemoved: (stats as Record<string, unknown>).linesRemoved as number }
              : {}),
            ...(typeof (stats as Record<string, unknown>).otherToolCount === 'number'
              ? { otherToolCount: (stats as Record<string, unknown>).otherToolCount as number }
              : {}),
          },
        }
      : {}),
  }
}

// ============ Claude 权限请求 → ApprovalRequest ============

/**
 * 把 claude 的权限请求（canUseTool 回调收到的 toolName + input）映射到 catmax 的 ApprovalRequest。
 *
 * 迁移到 Agent SDK 后，这个函数由 adapter 的 canUseTool 回调直接调用，
 * 不再经过 MCP approve tool + Unix socket 的中转。
 *
 * 映射规则：
 * - Bash → kind:'shell_command'，detail 显示 `$ <command>`
 * - Write / Edit / MultiEdit / NotebookEdit → kind:'file_edit'，detail 显示 JSON
 * - mcp__* 或其他 → kind:'mcp'，detail 显示 JSON
 * - 风险等级走共享的 assessRisk
 *
 * meta 透传 SDK canUseTool options 里的友好文案（displayName/description/decisionReason/title）。
 * title 优先用 SDK 的 "Claude wants to..."；没有时回退到自拼的 cmd/filePath/toolName。
 * displayName/description/decisionReason 原样透传（undefined 不填，前端回退到 detail）。
 */
export function claudePermissionToApprovalRequest(
  toolName: string,
  input: Record<string, unknown>,
  meta?: {
    displayName?: string | undefined
    description?: string | undefined
    decisionReason?: string | undefined
    title?: string | undefined
  },
): ApprovalRequest {
  if (toolName === 'ExitPlanMode') {
    const plan = typeof input.plan === 'string' ? input.plan : ''
    return {
      kind: 'mcp',
      title: '计划已准备好',
      detail: '',
      riskLevel: 'low',
      plan,
      ...pickMeta(meta),
    }
  }

  if (toolName === 'Bash') {
    const cmd = typeof input.command === 'string' ? input.command : JSON.stringify(input)
    const description = typeof input.description === 'string' ? input.description : undefined
    const detail = description ? `$ ${cmd}\n\n${description}` : `$ ${cmd}`
    return {
      kind: 'shell_command',
      // SDK 的 title（"Claude wants to run..."）优先；没有时回退到命令本身
      title: meta?.title || cmd.slice(0, 100),
      detail,
      riskLevel: assessRisk('shell_command', cmd),
      ...pickMeta(meta),
    }
  }

  if (
    toolName === 'Write' ||
    toolName === 'Edit' ||
    toolName === 'MultiEdit' ||
    toolName === 'NotebookEdit'
  ) {
    const filePath =
      typeof input.file_path === 'string'
        ? input.file_path
        : typeof input.notebook_path === 'string'
          ? input.notebook_path
          : '(unknown)'
    return {
      kind: 'file_edit',
      title: meta?.title || filePath,
      detail: JSON.stringify(input, null, 2),
      riskLevel: assessRisk('file_edit', filePath),
      ...pickMeta(meta),
    }
  }

  return {
    kind: 'mcp',
    title: meta?.title || toolName,
    detail: JSON.stringify(input, null, 2),
    riskLevel: 'medium',
    ...pickMeta(meta),
  }
}

/**
 * 从 meta 里挑出有值的 displayName/description/decisionReason，展开进 ApprovalRequest。
 * 全 undefined 时返回空对象（ApprovalRequest 这些字段都是 optional）。
 */
function pickMeta(meta?: {
  displayName?: string | undefined
  description?: string | undefined
  decisionReason?: string | undefined
}): Pick<ApprovalRequest, 'displayName' | 'description' | 'decisionReason'> {
  const out: Pick<ApprovalRequest, 'displayName' | 'description' | 'decisionReason'> = {}
  if (meta?.displayName) out.displayName = meta.displayName
  if (meta?.description) out.description = meta.description
  if (meta?.decisionReason) out.decisionReason = meta.decisionReason
  return out
}
