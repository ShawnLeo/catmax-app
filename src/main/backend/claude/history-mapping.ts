/**
 * claude 重放消息 → NormalizedMessage[]
 *
 * claude --resume <id> 启动后（不写 stdin），stdout 会按时间顺序重放：
 *   1. system/init（启动握手）
 *   2. 多条 assistant + user（含 tool_use / tool_result）—— 历史回放
 *   3. result（结束）
 *
 * 转换规则：
 *   - assistant.message.content 里的 text → textBlocks (kind: 'text')
 *   - assistant.message.content 里的 thinking → textBlocks (kind: 'reasoning')
 *   - assistant.message.content 里的 tool_use → 当前 assistant 的 toolBlocks（status: running）
 *   - 后续 user.message.content 里的 tool_result → 把对应 tool_use 标为 completed/failed
 *   - 后续 user.message.content 里的 text → 新的 user message
 *
 * 最后扫一遍：仍为 running 的 tool（缺失配对的 tool_result）→ 标为 completed（历史不应有 running）。
 */
import { randomUUID } from 'node:crypto'

import type {
  AssistantMessage,
  ClaudeStreamMessage,
  TextContent,
  ThinkingContent,
  ToolResultContent,
  ToolUseContent,
  UserMessage,
} from '@shared/backend/claude-schema'
import { extractContextTags } from '@shared/backend/context-tags'
import { sharedContextTagExtractors } from '@shared/backend/context-tag-handlers'
import type { NormalizedMessage, ToolCallInfo } from '@shared/backend/types'

import { toolResultToOutput, toolUseToInfo } from './mapping'

// contentBlockSchema 是 z.union 带 passthrough 兜底——switch(block.type) 不会收窄字段，
// 访问具体字段时显式 Extract + as cast（与 mapping.ts 一致）。

/** 把重放的 claude 消息流转成 NormalizedMessage[] */
export function claudeReplayToMessages(messages: ClaudeStreamMessage[]): NormalizedMessage[] {
  const result: NormalizedMessage[] = []
  let currentAssistant: NormalizedMessage | null = null
  // tool_use_id → 它所在的 assistant message（已 push 到 result）
  const pendingToolUseIds = new Map<string, { info: ToolCallInfo; messageId: string }>()

  function flushAssistant(): void {
    if (currentAssistant) {
      result.push(currentAssistant)
      currentAssistant = null
    }
  }

  for (const msg of messages) {
    if (msg.type === 'assistant') {
      // 新 assistant message——先 flush 上一个
      flushAssistant()
      const assistantMsg = msg as AssistantMessage
      const assistant: NormalizedMessage = {
        id: assistantMsg.message.id,
        role: 'assistant',
        turnId: 'history',
        textBlocks: [],
        toolBlocks: [],
        createdAt: 0,
      }
      for (const block of assistantMsg.message.content) {
        if (block.type === 'text') {
          const text = (block as TextContent).text
          if (text) {
            assistant.textBlocks!.push({ id: randomUUID(), text, kind: 'text' })
          }
        } else if (block.type === 'thinking') {
          const text = (block as ThinkingContent).thinking
          if (text) {
            assistant.textBlocks!.push({ id: randomUUID(), text, kind: 'reasoning' })
          }
        } else if (block.type === 'tool_use') {
          const tu = block as ToolUseContent
          const info = toolUseToInfo(tu)
          assistant.toolBlocks!.push({
            id: tu.id,
            info,
            status: 'running', // 等 tool_result 改成 completed/failed
          })
          // 即使 assistant 还没 flush，也按 id 索引——后面在 result 里查找
          pendingToolUseIds.set(tu.id, { info, messageId: assistant.id })
        }
        // 其他 block 类型（未知）跳过
      }
      currentAssistant = assistant
    } else if (msg.type === 'user') {
      // user message 可能含 tool_result（配对之前 assistant 的 tool_use）
      // 或含 text（用户真实输入）
      const userMsg = msg as UserMessage
      const content = userMsg.message.content
      for (const block of content) {
        if (block.type === 'tool_result') {
          const tr = block as ToolResultContent
          const output = toolResultToOutput(tr)
          // 在已 push 的 assistant（包括还没 flush 的 currentAssistant）里找
          const target =
            result.find((m) => pendingToolUseIds.get(tr.tool_use_id)?.messageId === m.id) ??
            (currentAssistant !== null &&
            pendingToolUseIds.get(tr.tool_use_id)?.messageId === currentAssistant.id
              ? currentAssistant
              : null)
          if (target?.toolBlocks) {
            const tb = target.toolBlocks.find((b) => b.id === tr.tool_use_id)
            if (tb) {
              tb.status = output.ok ? 'completed' : 'failed'
              tb.output = output
            }
          }
          pendingToolUseIds.delete(tr.tool_use_id)
        } else if (block.type === 'text') {
          // user 真实输入文本——flush 当前 assistant，新建 user message
          flushAssistant()
          const rawText = (block as TextContent).text
          // 提取 IDE context tag（<ide_selection> / <ide_opened_file> / <environment_context>）。
          // 提取后 textBlocks 存去掉 tag 的纯 prompt，contextBlocks 存结构化 tag。
          const { text, blocks } = extractContextTags(rawText, sharedContextTagExtractors)
          result.push({
            id: randomUUID(),
            role: 'user',
            turnId: 'history',
            textBlocks: [{ id: randomUUID(), text, kind: 'text' }],
            ...(blocks.length > 0 ? { contextBlocks: blocks } : {}),
            createdAt: 0,
          })
        }
        // 其他 block 类型跳过
      }
    }
    // system / result 不在这里处理
  }
  flushAssistant()

  // 历史不应有 running 状态的 tool——把没配对 tool_result 的标为 completed
  for (const msg of result) {
    if (msg.toolBlocks) {
      for (const tb of msg.toolBlocks) {
        if (tb.status === 'running') {
          tb.status = 'completed'
          tb.output = { ok: true, summary: '(no result recorded)' }
        }
      }
    }
  }

  return result
}
