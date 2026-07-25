import { messageBlocks, upgradeMessageBlocks } from '@shared/backend/normalize-blocks'
import type { NormalizedMessage } from '@shared/backend/types'
import { describe, expect, test } from 'vitest'

describe('messageBlocks', () => {
  test('upgrades legacy fields without changing their historical visual order', () => {
    const message: NormalizedMessage = {
      id: 'm1',
      role: 'assistant',
      turnId: 't1',
      contextBlocks: [{ tag: 'environment_context', data: { cwd: '/tmp' } }],
      textBlocks: [
        { id: 'r1', kind: 'reasoning', text: 'thinking' },
        { id: 'x1', kind: 'text', text: 'answer' },
      ],
      toolBlocks: [
        {
          id: 'tool1',
          info: { kind: 'shell_command', title: 'pwd' },
          status: 'completed',
        },
      ],
      createdAt: 0,
    }

    expect(messageBlocks(message).map((block) => block.type)).toEqual([
      'context',
      'tool_call',
      'reasoning',
      'text',
    ])
    expect(upgradeMessageBlocks(message).blocks).toEqual(messageBlocks(message))
  })

  test('preserves native block order', () => {
    const message: NormalizedMessage = {
      id: 'm1',
      role: 'assistant',
      turnId: 't1',
      blocks: [
        { id: 'p1', type: 'plan', text: 'one' },
        { id: 't1', type: 'text', text: 'two' },
      ],
      createdAt: 0,
    }
    expect(messageBlocks(message)).toBe(message.blocks)
  })
})
