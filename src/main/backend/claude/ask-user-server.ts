/**
 * 自定义 in-process MCP server：提供 ask_user 工具，让 claude agent 能在 headless SDK
 * 模式下向用户提问。
 *
 * 为什么需要这个：内置 AskUserQuestion 工具被 CLI 的 isInteractive 门控，Agent SDK
 * (-p / headless) 模式下永不进工具列表，模型无法调用。这里注册一个自定义 MCP 工具
 * ask_user 替代——自定义 MCP 工具不受该门控（PoC 已验证：正常进 tools 列表，模型自主调用）。
 *
 * 工作机制：
 * 1. SDK query 时把本 server 以 `mcpServers.catmax = { type:'sdk', instance }` 注入。
 * 2. 模型调用 mcp__catmax__ask_user({question, header, options, multiSelect})。
 * 3. handler 生成 requestId → 调 onQuestion 回调（adapter 转 agent_question 事件推给 UI）。
 * 4. handler await 一个 pendingQuestions 的 promise（阻塞，等用户回答）。
 * 5. 用户在 QuestionPanel 回答 → adapter 调 respondQuestion(requestId, answer) → resolve promise。
 * 6. handler 把答案组装成 tool_result 文本返回给模型 → 模型基于答案继续。
 *
 * MCP server 生命周期：每个 turn 创建一个（adapter 持有），turn 结束 dispose。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentAnswer, AgentQuestion, AgentQuestionOption } from '@shared/backend/types'
import { z } from 'zod'

/** ask_user 工具入参的 zod schema（同时驱动模型可见的工具 schema） */
const askUserSchema = {
  question: z
    .string()
    .describe('The question to ask. Clear, specific, ending with a question mark.'),
  header: z
    .string()
    .max(12)
    .optional()
    .describe('Very short label (max 12 chars) shown as a chip, e.g. "Auth method".'),
  options: z
    .array(
      z.object({
        label: z.string().describe('Concise option text (1-5 words).'),
        description: z
          .string()
          .optional()
          .describe('What this option means / implications of choosing it.'),
      }),
    )
    .min(2)
    .max(4)
    .optional()
    .describe(
      '2-4 mutually exclusive choices. Omit for a pure free-text question. Do NOT add "Other" — the user can always type freely.',
    ),
  multiSelect: z.boolean().optional().describe('Allow multiple selections. Default false.'),
}

/** handler 收到问题时，通过这个回调通知 adapter（adapter 再推 agent_question 事件） */
export type AskUserQuestionHandler = (requestId: string, question: AgentQuestion) => void

/** pending 问题：requestId → resolver。respondQuestion 时 resolve。 */
type PendingEntry = { resolve: (answer: AgentAnswer) => void }

/**
 * 创建一个 ask_user in-process MCP server。
 * 返回 server 实例 + respondQuestion 方法。adapter 持有并在 turn 结束时清理。
 */
export function createAskUserServer(onQuestion: AskUserQuestionHandler): {
  server: McpServer
  /** 用户回答后调用，resolve 对应 handler 的阻塞 promise */
  respondQuestion: (requestId: string, answer: AgentAnswer) => boolean
  /** 兜底：turn 结束/dispose 时 reject 所有未回答的问题，避免 promise 泄漏 */
  rejectAll: () => void
} {
  const pending = new Map<string, PendingEntry>()
  let counter = 0

  const server = new McpServer(
    { name: 'catmax', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.tool(
    'ask_user',
    `Ask the user ONE clarifying question when their request is ambiguous or needs a preference/decision before you proceed. Do NOT guess — if you're unsure about a meaningful choice (library, approach, scope), ask first. Call with a single question and 2-4 mutually exclusive options. Never add an "Other" option: the user can always type a free-form answer instead of picking. Ask at most one question per call; if you need multiple pieces of info, ask the most important one first.`,
    askUserSchema,
    async (args) => {
      const requestId = `q${++counter}`
      // 归一化成 AgentQuestion（zod 推断的 description 是 string|undefined，
      // 显式过滤掉 undefined 以满足 exactOptionalPropertyTypes）
      const question: AgentQuestion = { question: args.question }
      if (args.header) question.header = args.header
      if (args.multiSelect) question.multiSelect = args.multiSelect
      if (args.options) {
        question.options = args.options.map((o) => {
          const opt: AgentQuestionOption = { label: o.label }
          if (o.description) opt.description = o.description
          return opt
        })
      }
      // 推给 adapter → agent_question 事件 → UI 弹 QuestionPanel
      onQuestion(requestId, question)

      // 阻塞等用户回答
      const answer = await new Promise<AgentAnswer>((resolve) => {
        pending.set(requestId, { resolve })
      })

      return {
        content: [{ type: 'text', text: formatAnswerForModel(question, answer) }],
      }
    },
  )

  return {
    server,
    respondQuestion(requestId, answer) {
      const entry = pending.get(requestId)
      if (!entry) return false
      pending.delete(requestId)
      entry.resolve(answer)
      return true
    },
    rejectAll() {
      // 用户跳过/turn 结束：以空答案 resolve（让 handler 返回，模型据此继续）
      for (const [, entry] of pending) entry.resolve({ selectedLabels: [], freeText: '' })
      pending.clear()
    },
  }
}

/**
 * 把用户的回答格式化成给模型看的 tool_result 文本。
 * - 选了选项：[header] label1, label2
 * - 自由文本：原文
 * - 跳过（都空）：明确告诉模型用户跳过了
 */
function formatAnswerForModel(question: AgentQuestion, answer: AgentAnswer): string {
  const hasSelection = answer.selectedLabels.length > 0
  const hasFreeText = answer.freeText && answer.freeText.trim().length > 0

  if (!hasSelection && !hasFreeText) {
    return '用户跳过了这个问题（按了取消）。你可以基于你的最佳判断继续，或者换个角度再问。'
  }
  if (hasFreeText && !hasSelection) {
    return answer.freeText as string
  }
  const prefix = question.header || '回答'
  const selection = answer.selectedLabels.join(', ')
  return hasFreeText ? `[${prefix}] ${selection}\n${answer.freeText}` : `[${prefix}] ${selection}`
}
