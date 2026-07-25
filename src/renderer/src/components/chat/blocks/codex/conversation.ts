import type {
  CodexActivityContentBlock,
  ContentBlock,
  TextContentBlock,
} from '@shared/backend/blocks'
import { messageBlocks } from '@shared/backend/normalize-blocks'
import type { NormalizedMessage } from '@shared/backend/types'

export type CodexConversationEntry =
  | { kind: 'user'; id: string; message: NormalizedMessage }
  | { kind: 'compact'; id: string; summary?: string | undefined }
  | { kind: 'turn'; id: string; turnId: string; messages: NormalizedMessage[] }

export interface CodexTurnSections {
  processBlocks: ContentBlock[]
  finalBlocks: TextContentBlock[]
  reasoningBlocks: ContentBlock[]
}

/** Codex owns its turn composition: item-shaped messages are regrouped before rendering. */
export function buildCodexConversationEntries(
  messages: NormalizedMessage[],
): CodexConversationEntry[] {
  const entries: CodexConversationEntry[] = []

  for (const message of messages) {
    if (message.role === 'user') {
      const text = messageBlocks(message).filter(
        (block): block is TextContentBlock => block.type === 'text',
      )
      if (text[0]?.text === '/compact') {
        entries.push({ kind: 'compact', id: message.id, summary: text[1]?.text })
      } else {
        entries.push({ kind: 'user', id: message.id, message })
      }
      continue
    }

    const previous = entries[entries.length - 1]
    if (previous?.kind === 'turn' && previous.turnId === message.turnId) {
      previous.messages.push(message)
    } else {
      entries.push({
        kind: 'turn',
        id: `codex-turn-${message.turnId}-${message.id}`,
        turnId: message.turnId,
        messages: [message],
      })
    }
  }

  return entries
}

/**
 * The Codex header collapses the work log, not the final answer. `phase` is authoritative;
 * for older histories without it, the last text item is treated as the final answer.
 */
export function splitCodexTurn(messages: NormalizedMessage[]): CodexTurnSections {
  const blocks = messages.flatMap(messageBlocks)
  const explicitFinal = blocks.filter(
    (block): block is TextContentBlock => block.type === 'text' && block.phase === 'final_answer',
  )
  const unphasedText = blocks.filter(
    (block): block is TextContentBlock => block.type === 'text' && block.phase === undefined,
  )
  const fallbackFinal =
    explicitFinal.length === 0 && unphasedText.length > 0 ? unphasedText.at(-1) : undefined

  const finalBlocks =
    explicitFinal.length > 0 ? explicitFinal : fallbackFinal ? [fallbackFinal] : []
  const finalIds = new Set(finalBlocks.map((block) => block.id))
  const reasoningBlocks = blocks.filter((block) => block.type === 'reasoning')
  const processBlocks = coalesceCodexActivities(
    blocks.filter((block) => {
      if (block.type === 'context' || block.type === 'compact_divider') return false
      if (block.type === 'reasoning') return false
      return block.type !== 'text' || !finalIds.has(block.id)
    }),
  )

  return { processBlocks, finalBlocks, reasoningBlocks }
}

/** Consecutive app-server items form one visual activity row; commentary starts a new segment. */
function coalesceCodexActivities(blocks: ContentBlock[]): ContentBlock[] {
  const result: ContentBlock[] = []
  for (const block of blocks) {
    const previous = result[result.length - 1]
    if (previous?.type === 'codex_activity' && block.type === 'codex_activity') {
      result[result.length - 1] = mergeActivityBlocks(previous, block)
    } else {
      result.push(block)
    }
  }
  return result
}

function mergeActivityBlocks(
  previous: CodexActivityContentBlock,
  next: CodexActivityContentBlock,
): CodexActivityContentBlock {
  return {
    ...previous,
    activities: [...previous.activities, ...next.activities],
    status:
      previous.status === 'failed' || next.status === 'failed'
        ? 'failed'
        : previous.status === 'running' || next.status === 'running'
          ? 'running'
          : 'completed',
    durationMs: (previous.durationMs ?? 0) + (next.durationMs ?? 0),
    ...(next.turnDiff !== undefined ? { turnDiff: next.turnDiff } : {}),
    ...(next.turnDiffStats !== undefined ? { turnDiffStats: next.turnDiffStats } : {}),
  }
}
