import { matchInterruptMarker } from '@shared/backend/interrupt-marker'
import { messageBlocks } from '@shared/backend/normalize-blocks'
import type { NormalizedMessage } from '@shared/backend/types'

const DEFAULT_PREVIEW_LIMIT = 120

/** Session Nav Rail: only genuine user prompts receive navigation anchors. */
export function isNavigableUserMessage(message: NormalizedMessage): boolean {
  if (message.role !== 'user') return false

  const firstText = messageBlocks(message).find((block) => block.type === 'text')
  if (firstText?.type !== 'text') return true
  if (firstText.text === '/compact') return false
  return matchInterruptMarker(firstText.text) === null
}

/** Session Nav Rail: create a compact, screen-reader-friendly prompt preview. */
export function navigationPreview(
  message: NormalizedMessage,
  limit = DEFAULT_PREVIEW_LIMIT,
): string {
  const text = navigationMessageText(message).replace(/\s+/gu, ' ').trim()

  const characters = Array.from(text)
  const safeLimit = Math.max(0, limit)
  if (characters.length <= safeLimit) return text
  return `${characters.slice(0, safeLimit).join('')}…`
}

/** Session Nav Rail: preserve the complete prompt for the hover/focus tooltip. */
export function navigationMessageText(message: NormalizedMessage): string {
  const text = messageBlocks(message)
    .filter((block) => block.type === 'text' && block.text.trim().length > 0)
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n\n')
    .trim()

  if (!text) return '图片或附件消息'
  return text
}
