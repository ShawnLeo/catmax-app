import { describe, expect, test } from 'vitest'

import { chatContentWidthClass } from './chat-layout'

describe('chatContentWidthClass', () => {
  test('uses the shared responsive maximum width for all chat surfaces', () => {
    expect(chatContentWidthClass(false)).toContain(
      'max-w-3xl lg:max-w-screen-lg xl:max-w-[1280px] 2xl:max-w-[1440px]',
    )
  })

  test('reserves the navigation rail width only while the rail is visible', () => {
    expect(chatContentWidthClass(true)).toContain('w-[calc(100%-2.5rem)]')
    expect(chatContentWidthClass(false)).toContain('w-full')
  })
})
