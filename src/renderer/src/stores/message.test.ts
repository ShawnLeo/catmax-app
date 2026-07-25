import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, test } from 'vitest'

import { useMessageStore } from './message'

describe('message store Codex activity streaming', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('相邻活动聚合，并原位更新实时 diff 与命令输出', () => {
    const store = useMessageStore()
    store.setCurrentSession('session-1')

    store.applyEvent('session-1', {
      type: 'content_block_upsert',
      turnId: 'turn-1',
      block: {
        id: 'cmd-1',
        type: 'codex_activity',
        status: 'running',
        activities: [
          {
            id: 'cmd-1',
            kind: 'command',
            command: 'pnpm test',
            status: 'running',
          },
        ],
      },
    })
    store.applyEvent('session-1', {
      type: 'codex_activity_output_delta',
      turnId: 'turn-1',
      itemId: 'cmd-1',
      text: 'running',
    })
    store.applyEvent('session-1', {
      type: 'content_block_upsert',
      turnId: 'turn-1',
      block: {
        id: 'patch-1',
        type: 'codex_activity',
        status: 'running',
        activities: [
          {
            id: 'patch-1',
            kind: 'file_change',
            status: 'running',
            changes: [
              {
                path: '/repo/a.ts',
                kind: 'update',
                diff: '@@ -1 +1 @@\n-old\n+new',
                stats: { additions: 1, deletions: 1 },
              },
            ],
          },
        ],
      },
    })
    store.applyEvent('session-1', {
      type: 'codex_turn_diff_updated',
      turnId: 'turn-1',
      diff: '--- a/a.ts\n+++ b/a.ts\n-old\n+new\n+next',
    })

    expect(store.messages).toHaveLength(1)
    const block = store.messages[0]?.blocks?.[0]
    expect(block?.type).toBe('codex_activity')
    if (block?.type === 'codex_activity') {
      expect(block.activities).toHaveLength(2)
      expect(block.activities[0]).toMatchObject({ output: 'running' })
      expect(block.turnDiffStats).toEqual({ additions: 2, deletions: 1 })
    }
  })

  test('commentary 文本会切断活动聚合区段', () => {
    const store = useMessageStore()
    store.setCurrentSession('session-1')
    const activity = (id: string) => ({
      type: 'content_block_upsert' as const,
      turnId: 'turn-1',
      block: {
        id,
        type: 'codex_activity' as const,
        status: 'completed' as const,
        activities: [{ id, kind: 'command' as const, command: id, status: 'completed' as const }],
      },
    })

    store.applyEvent('session-1', activity('one'))
    store.applyEvent('session-1', {
      type: 'text_delta',
      turnId: 'turn-1',
      itemId: 'commentary',
      text: '中间进度',
    })
    store.applyEvent('session-1', activity('two'))

    expect(store.messages).toHaveLength(3)
    expect(store.messages[0]?.blocks?.[0]?.type).toBe('codex_activity')
    expect(store.messages[1]?.blocks?.[0]?.type).toBe('text')
    expect(store.messages[2]?.blocks?.[0]?.type).toBe('codex_activity')
  })
})
