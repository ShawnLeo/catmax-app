/**
 * PoC #1：验证内置 AskUserQuestion 在 Agent SDK headless 模式下是否可用，
 * 以及 streaming-input 注入 mid-turn user message 的行为。
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 结论（2026-07 实测，claude-agent-sdk@0.3.218）：                    │
 * │ ❌ AskUserQuestion 永远不进 tools 列表（被 isInteractive 门控）。    │
 * │    无论 -p 模式还是 SDK streaming-input 模式，tools=40，无该工具。   │
 * │    各种 env（CLAUDE_CODE_INTERACTIVE=1 等）都无法绕过。              │
 * │ ✅ streaming-input 注入 mid-turn user message 被 SDK 接受，          │
 * │    但产生的是新的 assistant turn，不是"在同一 turn 内回答"。         │
 * │                                                                     │
 * │ 意义：证明"往正在跑的 turn 注入答案"这条路对 AskUserQuestion 无意义  │
 * │（工具本身不可用）。相关死代码已清理。正确的解法见 poc/02。           │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 运行：node poc/01-askuserquestion-gating.mjs [A|B|C]
 *   A = 注入带 tool_use_result 的 SDKUserMessage（尝试关闭 tool_use）
 *   B = 注入普通文本 user message
 *   C = 对照（不注入）
 *
 * 前置：需已 claude 登录（subscription / API key）。SDK 自带 binary 会用 ~/.claude 凭证。
 */
import { query } from '@anthropic-ai/claude-agent-sdk'

const MODE = (process.argv[2] || 'A').toUpperCase()

const PROMPT = `请使用 AskUserQuestion 工具问我一个问题：「你希望用哪种日志库？」选项：pino、winston。问完之后，根据我的回答，用一句话告诉我你会用哪个库。不要用别的方式问，必须用 AskUserQuestion 工具。`

async function makeInputStream() {
  const queue = []
  let resolveWait = null
  let closed = false

  queue.push({
    type: 'user',
    message: { role: 'user', content: PROMPT },
    parent_tool_use_id: null,
  })

  return {
    stream: (async function* () {
      while (!closed) {
        while (queue.length > 0) yield queue.shift()
        if (closed) break
        await new Promise((r) => {
          resolveWait = r
        })
        resolveWait = null
      }
    })(),
    push(msg) {
      queue.push(msg)
      resolveWait?.()
    },
    close() {
      closed = true
      resolveWait?.()
    },
  }
}

function summarizeContent(block) {
  if (block.type === 'text') return `text(${(block.text || '').slice(0, 60)})`
  if (block.type === 'tool_use') return `tool_use(${block.name}#${block.id})`
  if (block.type === 'tool_result')
    return `tool_result(for=${block.tool_use_id}, ${JSON.stringify(block.content).slice(0, 80)})`
  return `${block.type}(?)`
}

async function run() {
  console.log(`\n========== PoC #1 MODE ${MODE} ==========`)

  const { stream, push, close } = await makeInputStream()

  const options = {
    abortController: new AbortController(),
    includePartialMessages: true,
    settings: { askUserQuestionTimeout: 'never' },
  }

  const q = query({ prompt: stream, options })

  let sawAskUserQuestion = false
  let askUserQuestionToolUseId = null
  let injected = false
  let sawToolResultForAsk = false
  let sawResult = false
  let resultSubtype = null
  let modelFollowupText = []
  const toolUseIds = new Set()
  const toolResultForIds = new Set()

  try {
    for await (const msg of q) {
      const t = msg.type
      if (t === 'system') {
        if (msg.subtype === 'init') {
          console.log(
            `[init] session ${msg.session_id} model ${msg.model} | tools=${(msg.tools || []).length} AskUserQuestion 在列表里: ${(msg.tools || []).includes('AskUserQuestion')}`,
          )
        }
        continue
      }
      if (t === 'assistant') {
        for (const b of msg.message.content) {
          console.log(`  [assistant block] ${summarizeContent(b)}`)
          if (b.type === 'tool_use') {
            toolUseIds.add(b.id)
            if (b.name === 'AskUserQuestion') {
              sawAskUserQuestion = true
              askUserQuestionToolUseId = b.id
              console.log(`  ★ AskUserQuestion tool_use id=${b.id}`)

              if (!injected) {
                injected = true
                if (MODE === 'A') {
                  const toolUseResult = {
                    questions: b.input.questions,
                    answers: { [b.input.questions[0].question]: 'pino' },
                  }
                  push({
                    type: 'user',
                    message: {
                      role: 'user',
                      content: [
                        {
                          type: 'tool_result',
                          tool_use_id: b.id,
                          content: JSON.stringify(toolUseResult),
                        },
                      ],
                    },
                    parent_tool_use_id: null,
                    tool_use_result: toolUseResult,
                  })
                  console.log(`  → [A] injected tool_use_result for ${b.id}`)
                } else if (MODE === 'B') {
                  push({
                    type: 'user',
                    message: { role: 'user', content: '我选 pino。' },
                    parent_tool_use_id: null,
                  })
                  console.log(`  → [B] injected plain user text "我选 pino。"`)
                } else if (MODE === 'C') {
                  console.log(`  → [C] 注入 disabled（对照，等 CLI 自动处理）`)
                }
              }
            }
          }
          if (b.type === 'text') modelFollowupText.push(b.text)
        }
        continue
      }
      if (t === 'user') {
        const content = msg.message?.content
        if (Array.isArray(content)) {
          for (const b of content) {
            console.log(`  [user block] ${summarizeContent(b)}`)
            if (b.type === 'tool_result') {
              toolResultForIds.add(b.tool_use_id)
              if (b.tool_use_id === askUserQuestionToolUseId) {
                sawToolResultForAsk = true
                console.log(`  ★ tool_result FOR AskUserQuestion detected`)
              }
            }
          }
        } else if (typeof content === 'string') {
          console.log(`  [user text] ${content.slice(0, 80)}`)
        }
        continue
      }
      if (t === 'result') {
        sawResult = true
        resultSubtype = msg.subtype
        console.log(`  [result] subtype=${msg.subtype} is_error=${msg.is_error}`)
        break
      }
    }
  } catch (e) {
    console.error('STREAM ERROR:', e?.message || e)
  } finally {
    close()
  }

  console.log('\n---------- PoC #1 结论 ----------')
  console.log(`检测到 AskUserQuestion tool_use: ${sawAskUserQuestion}`)
  console.log(`(预期 false —— 工具被 isInteractive 门控，headless 下不可用)`)
  console.log(`turn result: ${sawResult} (subtype=${resultSubtype})`)
  console.log(`模型后续文本: ${modelFollowupText.join(' ').slice(0, 200) || '(无)'}`)
  console.log('==============================\n')
}

run().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
