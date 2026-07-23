/**
 * PoC #2：验证自定义 in-process ask_user MCP 工具在 headless Agent SDK 下可行。
 * （这是当前生产实现 src/main/backend/claude/ask-user-server.ts 的原型）
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 结论（2026-07 实测，claude-agent-sdk@0.3.218）：                    │
 * │ ✅ type:'sdk' 的 in-process McpServer 无需手动 transport 即可接入。  │
 * │ ✅ ask_user 进 init 的 tools 列表（mcp__catmax__ask_user）——          │
 * │    证明自定义 MCP 工具不受 isInteractive 门控（与内置 AskUserQuestion │
 * │    不同，后者被门控永不进列表，见 poc/01）。                         │
 * │ ✅ 模型自主调用 ask_user（给模糊任务"配置日志"，模型分析后主动问）。  │
 * │ ✅ handler 阻塞等答案 → 答案作为 tool_result 回流 → 模型读取答案继续。│
 * │                                                                     │
 * │ 意义：这是 SDK 下"agent 问用户问题"的正确实现方式。                  │
 * │ 内置 AskUserQuestion 不可用，用自定义 MCP 工具替代。                 │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 运行：node poc/02-askuser-mcp-tool.mjs
 *
 * 前置：需已 claude 登录（subscription / API key）。SDK 自带 binary 会用 ~/.claude 凭证。
 *
 * 注意：脚本里用 setTimeout 3 秒后自动回答（模拟用户），生产代码里是等前端
 * respondQuestion IPC 回调。真实回答请改 simulateUserAnswer 的逻辑。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

// ---- 1. 创建 in-process ask_user MCP server ----
const askUserServer = new McpServer(
  { name: 'catmax', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

// pending questions: requestId → resolver
const pendingQuestions = new Map()
let questionCounter = 0

// 模拟"前端回答"：3 秒后自动回答第一个 pending question。
// 生产代码里这是 QuestionPanel → respondQuestion IPC → adapter.respondQuestion → resolve。
function simulateUserAnswer() {
  setTimeout(() => {
    for (const [rid, resolve] of pendingQuestions) {
      console.log(`  [模拟用户] 回答 question ${rid}`)
      pendingQuestions.delete(rid)
      resolve({ selectedLabels: ['（模拟答案）'], freeText: undefined })
      break
    }
  }, 3000)
}

askUserServer.tool(
  'ask_user',
  `Ask the user a single clarifying question when you need information, preference, or a decision before proceeding. Call this tool with ONE question (not a batch). Provide 2-4 mutually exclusive options. Do NOT add an 'Other' option — the user can always type a free-form answer instead of picking. Use this proactively when the request is ambiguous.`,
  {
    question: z.string().describe('The question to ask. Clear, specific, ending with ?.'),
    header: z.string().optional().describe('Short label (max 12 chars) for the question.'),
    options: z
      .array(
        z.object({
          label: z.string(),
          description: z.string().optional(),
        }),
      )
      .min(2)
      .max(4)
      .describe('2-4 mutually exclusive choices.'),
    multiSelect: z.boolean().optional(),
  },
  async (args) => {
    const requestId = `q${++questionCounter}`
    console.log(`\n  ★ ask_user CALLED: ${JSON.stringify(args).slice(0, 150)}`)
    simulateUserAnswer()
    const answer = await new Promise((resolve) => {
      pendingQuestions.set(requestId, resolve)
    })
    // 组装 tool_result 文本回给模型（生产代码见 ask-user-server.ts 的 formatAnswerForModel）
    const answerStr =
      answer.freeText || `[${args.header || 'answer'}] ${answer.selectedLabels.join(', ')}`
    console.log(`  → tool_result 回流给模型: "${answerStr}"\n`)
    return { content: [{ type: 'text', text: answerStr }] }
  },
)

// ---- 2. 用 SDK query 跑起来 ----
const GUIDE = `
## Using ask_user to ask the user questions

You have an "ask_user" MCP tool. When the user's request is AMBIGUOUS or needs a preference/decision, do NOT guess — call ask_user to ask ONE clarifying question first. For example, if asked to "configure logging" without specifying a library, call ask_user to ask which logging library to use.
`

console.log('========== PoC #2: ask_user in-process MCP 工具 ==========\n')

const q = query({
  prompt: '帮我在项目里配置一下日志。', // 故意模糊，引导模型问
  options: {
    includePartialMessages: true,
    mcpServers: {
      catmax: { type: 'sdk', name: 'catmax', instance: askUserServer },
    },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: GUIDE },
    canUseTool: async (toolName, input) => {
      console.log(`  [canUseTool] ${toolName}`)
      // 生产代码这里要白名单放行 ask_user，避免误弹权限面板
      return { behavior: 'allow', updatedInput: input }
    },
  },
})

let sawAskUser = false
let turn = 0
for await (const m of q) {
  if (m.type === 'system' && m.subtype === 'init') {
    const tools = m.tools || []
    console.log(
      `[init] tools=${tools.length}, ask_user 在列表里: ${tools.includes('mcp__catmax__ask_user')}`,
    )
  } else if (m.type === 'assistant') {
    turn++
    for (const b of m.message.content || []) {
      if (b.type === 'tool_use') {
        console.log(`[turn ${turn} tool_use] ${b.name}`)
        if (b.name.includes('ask_user')) sawAskUser = true
      } else if (b.type === 'text') {
        console.log(`[turn ${turn} text] ${b.text.slice(0, 120)}`)
      }
    }
  } else if (m.type === 'result') {
    console.log(`[result] subtype=${m.subtype}`)
    break
  }
}

console.log(`\n---------- PoC #2 结论 ----------`)
console.log(`ask_user 被模型调用: ${sawAskUser}`)
console.log(`(预期 true —— 自定义 MCP 工具不受 isInteractive 门控)`)
console.log(`==============================\n`)
