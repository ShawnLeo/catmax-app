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

  const result = claudeStreamMessageSchema.safeParse(parsed)
  if (!result.success) {
    log.warn('claude message failed schema:', result.error.issues.slice(0, 2))
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
