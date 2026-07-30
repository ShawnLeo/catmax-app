/**
 * Protocol Bridge codec 注册表。
 *
 * 加一个新协议只要：写一个 codec 文件 + 在这里注册一行。
 * 所有已注册协议之间自动互通（IR 中心辐射），不用为每个组合写代码。
 */
import type { ProtocolCodec } from '@shared/protocol/codec'
import type { ProtocolId } from '@shared/protocol/ir'

import { anthropicMessagesCodec } from './codecs/anthropic-messages'
import { openaiResponsesCodec } from './codecs/openai-responses'

const CODECS = new Map<ProtocolId, ProtocolCodec>([
  [openaiResponsesCodec.id, openaiResponsesCodec],
  [anthropicMessagesCodec.id, anthropicMessagesCodec],
])

export function getCodec(id: ProtocolId): ProtocolCodec {
  const codec = CODECS.get(id)
  if (!codec) throw new Error(`未注册的协议 codec: ${id}`)
  return codec
}

export function hasCodec(id: string): id is ProtocolId {
  return CODECS.has(id as ProtocolId)
}
