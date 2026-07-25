import type { ContentBlock } from './blocks'
import type { NormalizedMessage } from './types'

/**
 * Reads both the new ordered contract and pre-block messages.
 * This is deliberately pure so history loaded from older CatMax versions is not mutated.
 */
export function messageBlocks(message: NormalizedMessage): ContentBlock[] {
  if (message.blocks) return message.blocks

  const blocks: ContentBlock[] = []
  for (const context of message.contextBlocks ?? []) {
    blocks.push({
      id: `${message.id}-context-${blocks.length}`,
      type: 'context',
      ...context,
    })
  }
  for (const tool of message.toolBlocks ?? []) {
    blocks.push({ type: 'tool_call', ...tool })
  }
  for (const text of message.textBlocks ?? []) {
    blocks.push({
      id: text.id,
      type: text.kind === 'reasoning' ? 'reasoning' : 'text',
      text: text.text,
      ...(text.startedAt !== undefined ? { startedAt: text.startedAt } : {}),
      ...(text.endedAt !== undefined ? { endedAt: text.endedAt } : {}),
    })
  }
  return blocks
}

export function upgradeMessageBlocks(message: NormalizedMessage): NormalizedMessage {
  if (message.blocks) return message
  return { ...message, blocks: messageBlocks(message) }
}
