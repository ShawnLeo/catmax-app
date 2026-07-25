import type { NormalizedMessage } from '@shared/backend/types'
import { describe, expect, test } from 'vitest'

import { buildCodexConversationEntries, splitCodexTurn } from './conversation'

function message(
  id: string,
  role: NormalizedMessage['role'],
  turnId: string,
  blocks: NonNullable<NormalizedMessage['blocks']>,
): NormalizedMessage {
  return { id, role, turnId, blocks, createdAt: 0 }
}

describe('Codex conversation composition', () => {
  test('groups item-shaped assistant messages into one turn', () => {
    const entries = buildCodexConversationEntries([
      message('u1', 'user', 't1', [{ id: 'u1-text', type: 'text', text: 'go' }]),
      message('r1', 'assistant', 't1', [
        { id: 'r1', type: 'reasoning', text: 'thinking', completedLabel: '已处理' },
      ]),
      message('a1', 'assistant', 't1', [
        { id: 'a1-text', type: 'text', text: 'checking', phase: 'commentary' },
      ]),
      message('f1', 'assistant', 't1', [
        { id: 'f1-text', type: 'text', text: 'done', phase: 'final_answer' },
      ]),
    ])

    expect(entries).toHaveLength(2)
    expect(entries[1]).toMatchObject({ kind: 'turn', turnId: 't1' })
    if (entries[1]?.kind === 'turn') expect(entries[1].messages).toHaveLength(3)
  })

  test('keeps commentary in the work log and final answer outside it', () => {
    const sections = splitCodexTurn([
      message('a1', 'assistant', 't1', [
        { id: 'commentary', type: 'text', text: 'checking', phase: 'commentary' },
        {
          id: 'activity',
          type: 'codex_activity',
          status: 'completed',
          activities: [],
        },
        { id: 'final', type: 'text', text: 'done', phase: 'final_answer' },
      ]),
    ])

    expect(sections.processBlocks.map((block) => block.id)).toEqual(['commentary', 'activity'])
    expect(sections.finalBlocks.map((block) => block.id)).toEqual(['final'])
  })

  test('coalesces adjacent activities but keeps commentary as a segment boundary', () => {
    const sections = splitCodexTurn([
      message('a1', 'assistant', 't1', [
        {
          id: 'activity-1',
          type: 'codex_activity',
          status: 'completed',
          activities: [
            {
              id: 'read',
              kind: 'file_read',
              path: 'a.ts',
              command: 'cat a.ts',
              status: 'completed',
            },
          ],
        },
      ]),
      message('a2', 'assistant', 't1', [
        {
          id: 'activity-2',
          type: 'codex_activity',
          status: 'completed',
          activities: [
            {
              id: 'edit',
              kind: 'file_change',
              status: 'completed',
              changes: [],
            },
          ],
        },
        { id: 'commentary', type: 'text', text: 'next', phase: 'commentary' },
        {
          id: 'activity-3',
          type: 'codex_activity',
          status: 'completed',
          activities: [
            { id: 'command', kind: 'command', command: 'pnpm test', status: 'completed' },
          ],
        },
      ]),
    ])

    expect(sections.processBlocks.map((block) => block.id)).toEqual([
      'activity-1',
      'commentary',
      'activity-3',
    ])
    const first = sections.processBlocks[0]
    expect(
      first?.type === 'codex_activity' ? first.activities.map((item) => item.kind) : [],
    ).toEqual(['file_read', 'file_change'])
  })

  test('uses only the last legacy text block as the final answer', () => {
    const sections = splitCodexTurn([
      message('a1', 'assistant', 't1', [
        { id: 'progress', type: 'text', text: 'checking' },
        { id: 'answer', type: 'text', text: 'done' },
      ]),
    ])

    expect(sections.processBlocks.map((block) => block.id)).toEqual(['progress'])
    expect(sections.finalBlocks.map((block) => block.id)).toEqual(['answer'])
  })
})
