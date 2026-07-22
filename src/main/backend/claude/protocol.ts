/**
 * Claude CLI 协议层。
 *
 * Claude 用 newline-delimited JSON（不是 JSON-RPC），单向流。
 * 这里复用 codex 的 LineBuffer（同行），只加 claude 特有的 encode 函数。
 */
import { logger } from '@main/service/logger'
import { claudeStreamMessageSchema, type ClaudeStreamMessage } from '@shared/backend/claude-schema'

import { LineBuffer } from '../codex/protocol'

const log = logger.domain('claude-protocol')

export { LineBuffer }

/** 解析单行 claude 消息 */
export function parseClaudeLine(line: string): ClaudeStreamMessage | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (e) {
    log.warn('failed to parse claude JSON line:', trimmed.slice(0, 200), e)
    return null
  }

  // user message 的 content 可能是 string（不是 array）——比如 /compact 后 claude
  // 重放注入的 "This session is being continued..." / <local-command-caveat> 等。
  // userMessageSchema 只接受 array form，这里先 normalize 成 array 再过 schema，
  // 否则会被 schema 拒绝（跟 jsonl-reader.normalizeUserContent 同样的处理）。
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    (parsed as { type?: string }).type === 'user'
  ) {
    const msg = (parsed as { message?: { content?: unknown } }).message
    if (msg && typeof msg.content === 'string') {
      msg.content = [{ type: 'text', text: msg.content }]
    }
  }

  const result = claudeStreamMessageSchema.safeParse(parsed)
  if (!result.success) {
    // 5 个 unionErrors 对应 5 个分支都失败——基本意味着是新消息类型。
    // 把 raw line 完整打出来方便排查。
    log.warn('claude message failed schema (all branches):', result.error.issues.slice(0, 2))
    log.warn('claude message failed schema, raw line:', trimmed.slice(0, 1500))
    return null
  }
  return result.data
}

/** 序列化要写入 claude stdin 的 user 消息 */
export function encodeUserMessage(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: text,
    },
  })
}
