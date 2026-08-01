import type {
  CodexActivityContentBlock,
  CodexGeneratedImageContentBlock,
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
  generatedImageBlocks: CodexGeneratedImageContentBlock[]
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
  // 防御旧实时状态：历史实现分别用 block id（`${itemId}-text`）和原始 itemId
  // 创建消息，同一块会出现两遍。以 block id 去重，并优先保留带 phase 的完成快照。
  const blocks = dedupeBlocks(messages.flatMap(messageBlocks))
  const explicitFinal = blocks.filter(
    (block): block is TextContentBlock => block.type === 'text' && block.phase === 'final_answer',
  )
  const unphasedText = blocks.filter(
    (block): block is TextContentBlock => block.type === 'text' && block.phase === undefined,
  )
  // Streaming ordering bug fix: the "last unphased text is the final answer"
  // fallback was written for legacy histories that carry NO phase info at all —
  // there the genuinely last text is plausibly the answer. But during live
  // streaming, agentMessage text arrives via text_delta with NO phase; the
  // phase only lands later when item/completed fires. Hoisting such a text out
  // of processBlocks while it still has a later sibling (e.g. a command that
  // ran afterwards) left two activity blocks adjacent and let
  // coalesceCodexActivities merge them — so every later command rendered under
  // the FIRST "搜索了代码运行了命令" header instead of starting a new row below
  // the Markdown. Only treat unphased text as the final answer when it is the
  // actual trailing block of the turn.
  const trailingUnphased = unphasedText.length > 0 ? unphasedText.at(-1) : undefined
  const isTrailing =
    trailingUnphased !== undefined && blocks[blocks.length - 1]?.id === trailingUnphased.id
  const fallbackFinal = explicitFinal.length === 0 && isTrailing ? trailingUnphased : undefined

  const finalBlocks =
    explicitFinal.length > 0 ? explicitFinal : fallbackFinal ? [fallbackFinal] : []
  const finalIds = new Set(finalBlocks.map((block) => block.id))
  const reasoningBlocks = blocks.filter((block) => block.type === 'reasoning')
  const generatedImageBlocks = blocks.filter(
    (block): block is CodexGeneratedImageContentBlock => block.type === 'codex_generated_image',
  )
  const processBlocks = coalesceCodexActivities(
    blocks.filter((block) => {
      if (block.type === 'context' || block.type === 'compact_divider') return false
      if (block.type === 'reasoning') return false
      if (block.type === 'codex_generated_image') return false
      return block.type !== 'text' || !finalIds.has(block.id)
    }),
  )

  return { processBlocks, finalBlocks, generatedImageBlocks, reasoningBlocks }
}

function dedupeBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const result: ContentBlock[] = []
  const indexById = new Map<string, number>()

  for (const block of blocks) {
    const existingIndex = indexById.get(block.id)
    if (existingIndex === undefined) {
      indexById.set(block.id, result.length)
      result.push(block)
      continue
    }

    const existing = result[existingIndex]!
    if (existing.type === 'text' && block.type === 'text') {
      if (existing.phase !== undefined && block.phase === undefined) continue
      if (block.phase !== undefined || block.text.length >= existing.text.length) {
        result[existingIndex] = block
      }
      continue
    }
    result[existingIndex] = block
  }

  return result
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
