import type { NormalizedMessage } from '@shared/backend/types'
import { describe, expect, test } from 'vitest'

import {
  isNavigableUserMessage,
  navigationMessageText,
  navigationPreview,
} from './message-navigation'

function message(
  role: NormalizedMessage['role'],
  blocks: NonNullable<NormalizedMessage['blocks']>,
): NormalizedMessage {
  return { id: 'message', role, turnId: 'turn', blocks, createdAt: 0 }
}

describe('message navigation', () => {
  test('only includes genuine user prompts', () => {
    expect(
      isNavigableUserMessage(message('user', [{ id: 'text', type: 'text', text: '实现这个功能' }])),
    ).toBe(true)
    expect(
      isNavigableUserMessage(message('assistant', [{ id: 'text', type: 'text', text: '完成了' }])),
    ).toBe(false)
    expect(
      isNavigableUserMessage(message('user', [{ id: 'text', type: 'text', text: '/compact' }])),
    ).toBe(false)
    expect(
      isNavigableUserMessage(
        message('user', [
          { id: 'text', type: 'text', text: '[Request interrupted by user for tool use]' },
        ]),
      ),
    ).toBe(false)
  })

  test('joins text blocks and collapses whitespace', () => {
    const preview = navigationPreview(
      message('user', [
        { id: 'first', type: 'text', text: '  第一段\n换行  ' },
        { id: 'second', type: 'text', text: '\t第二段' },
      ]),
    )

    expect(preview).toBe('第一段 换行 第二段')
  })

  test('keeps the complete user message for the tooltip', () => {
    const fullText = navigationMessageText(
      message('user', [
        { id: 'first', type: 'text', text: '第一段保留换行\n下一行' },
        { id: 'second', type: 'text', text: '第二段也完整展示' },
      ]),
    )

    expect(fullText).toBe('第一段保留换行\n下一行\n\n第二段也完整展示')
  })

  test('truncates by Unicode code point without splitting emoji', () => {
    const preview = navigationPreview(
      message('user', [{ id: 'text', type: 'text', text: '😀😀😀继续' }]),
      3,
    )

    expect(preview).toBe('😀😀😀…')
  })

  test('keeps attachment-only turns discoverable', () => {
    const attachment = message('user', [
      { id: 'image', type: 'codex_user_input', kind: 'image', path: '/tmp/image.png' },
    ])

    expect(isNavigableUserMessage(attachment)).toBe(true)
    expect(navigationPreview(attachment)).toBe('图片或附件消息')
  })
})
