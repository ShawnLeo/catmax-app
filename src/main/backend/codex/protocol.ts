/**
 * codex JSON-RPC 协议解析层。
 *
 * 职责：
 * - 把 stdout 字节流切分成 newline-delimited JSON 帧
 * - 把 JSON 对象用 Zod schema 校验后分类（request/response/notification）
 * - 提供 sendRequest / sendNotification / sendResponse 给 adapter 用
 *
 * 不做任何业务语义解释——只管字节流 ↔ 结构化消息。
 */
import { randomUUID } from 'node:crypto'

import { logger } from '@main/service/logger'
import {
  jsonRpcMessageSchema,
  jsonRpcNotificationSchema,
  jsonRpcRequestSchema,
  jsonRpcResponseSchema,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '@shared/backend/schema'

const log = logger.domain('codex-protocol')

/** 解析单行 JSON。非法行返回 null（不抛错，避免污染流） */
export function parseFrame(line: string): JsonRpcMessage | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (e) {
    log.warn('failed to parse JSON line:', trimmed.slice(0, 200), e)
    return null
  }

  const result = jsonRpcMessageSchema.safeParse(parsed)
  if (!result.success) {
    log.warn('frame failed schema validation:', result.error.issues.slice(0, 3))
    return null
  }
  return result.data
}

/** 分类消息：request（server 主动发的请求，需要响应）/ response（匹配我方请求）/ notification（单向推送） */
export type ClassifiedMessage =
  | { kind: 'server-request'; message: JsonRpcRequest }
  | { kind: 'response'; message: JsonRpcResponse }
  | { kind: 'notification'; message: JsonRpcNotification }

export function classifyMessage(msg: JsonRpcMessage): ClassifiedMessage | null {
  // 有 method + id = request（client→server 或 server→client）
  if ('method' in msg && 'id' in msg) {
    const req = jsonRpcRequestSchema.safeParse(msg)
    if (req.success) return { kind: 'server-request', message: req.data }
  }
  // 有 id 但无 method = response
  if ('id' in msg && !('method' in msg)) {
    const res = jsonRpcResponseSchema.safeParse(msg)
    if (res.success) return { kind: 'response', message: res.data }
  }
  // 有 method 但无 id = notification
  if ('method' in msg && !('id' in msg)) {
    const notif = jsonRpcNotificationSchema.safeParse(msg)
    if (notif.success) return { kind: 'notification', message: notif.data }
  }
  return null
}

/** 把 stdout 字节流切分成完整行（处理跨 chunk 的不完整行） */
export class LineBuffer {
  private buffer = ''

  /** 推入新字节，返回完整的行（不含换行符） */
  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    const lines: string[] = []
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      if (line.trim()) lines.push(line)
    }
    return lines
  }

  /** 取出剩余未完成行（用于 stream 关闭时 flush） */
  flush(): string | null {
    if (this.buffer.trim()) {
      const rest = this.buffer
      this.buffer = ''
      return rest
    }
    return null
  }
}

/** 序列化 client → server 的请求（带 id） */
export function encodeRequest(method: string, params?: unknown, id?: number | string): string {
  const frame: JsonRpcRequest = {
    method,
    id: id ?? randomUUID(),
    params,
  }
  return JSON.stringify(frame)
}

/** 序列化 client → server 的通知（无 id） */
export function encodeNotification(method: string, params?: unknown): string {
  const frame: JsonRpcNotification = { method, params }
  return JSON.stringify(frame)
}

/** 序列化对 server-request 的响应 */
export function encodeResponse(id: number | string, result: unknown): string {
  const frame: JsonRpcResponse = { id, result }
  return JSON.stringify(frame)
}
