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
  test('keeps generated images visible outside the collapsed work log', () => {
    const sections = splitCodexTurn([
      message('image-message', 'assistant', 'turn-1', [
        {
          id: 'generated-1',
          type: 'codex_generated_image',
          url: 'data:image/png;base64,AAAA',
          path: '/tmp/generated-1.png',
        },
      ]),
    ])

    expect(sections.processBlocks).toEqual([])
    expect(sections.generatedImageBlocks).toEqual([
      expect.objectContaining({ id: 'generated-1', type: 'codex_generated_image' }),
    ])
  })

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

  test('does not coalesce activities across a trailing unphased text during streaming', () => {
    // Reproduces the live-streaming bug: while a turn is in flight, the commentary
    // text item streams in via text_delta (so it has NO phase yet). The fallback
    // "last unphased text is the final answer" heuristic was hoisting that text
    // out of processBlocks, which left the two activity blocks adjacent in
    // processBlocks and let coalesceCodexActivities merge them into one row —
    // so every command run after the Markdown appeared under the FIRST header.
    const sections = splitCodexTurn([
      message('a1', 'assistant', 't1', [
        {
          id: 'activity-1',
          type: 'codex_activity',
          status: 'completed',
          activities: [
            { id: 'read', kind: 'file_read', path: 'a.ts', command: 'cat', status: 'completed' },
          ],
        },
      ]),
      message('t1', 'assistant', 't1', [
        // No phase — this is exactly what the renderer sees mid-stream.
        { id: 'commentary', type: 'text', text: 'let me also run the tests' },
      ]),
      message('a2', 'assistant', 't1', [
        {
          id: 'activity-2',
          type: 'codex_activity',
          status: 'completed',
          activities: [{ id: 'cmd', kind: 'command', command: 'pnpm test', status: 'completed' }],
        },
      ]),
    ])

    // The activities must stay as two separate rows; the text must survive as a
    // boundary between them. (Before the fix this returned ['activity-1'] with
    // both activities merged, and finalBlocks = ['commentary'].)
    expect(sections.processBlocks.map((block) => block.id)).toEqual([
      'activity-1',
      'commentary',
      'activity-2',
    ])
    expect(sections.finalBlocks).toEqual([])
  })

  test('keeps unphased live text in the processing panel until its phase is known', () => {
    const sections = splitCodexTurn(
      [
        message('streaming', 'assistant', 't1', [
          { id: 'streaming-text', type: 'text', text: '我再检查一下调用链' },
        ]),
      ],
      { running: true },
    )

    expect(sections.processBlocks.map((block) => block.id)).toEqual(['streaming-text'])
    expect(sections.finalBlocks).toEqual([])
  })

  test('deduplicates legacy completed snapshot and delta messages by block id', () => {
    const sections = splitCodexTurn([
      message('message-1-text', 'assistant', 't1', [
        {
          id: 'message-1-text',
          type: 'text',
          text: 'checking',
          phase: 'commentary',
        },
      ]),
      message('message-1', 'assistant', 't1', [
        { id: 'message-1-text', type: 'text', text: 'checking' },
      ]),
    ])

    expect(sections.processBlocks).toEqual([
      {
        id: 'message-1-text',
        type: 'text',
        text: 'checking',
        phase: 'commentary',
      },
    ])
    expect(sections.finalBlocks).toEqual([])
  })
})
