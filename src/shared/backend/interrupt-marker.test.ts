import { matchInterruptMarker } from '@shared/backend/interrupt-marker'
import { describe, expect, test } from 'vitest'

describe('matchInterruptMarker', () => {
  test('识别 [Request interrupted by user] → variant: user', () => {
    expect(matchInterruptMarker('[Request interrupted by user]')).toEqual({ variant: 'user' })
  })

  test('识别 [Request interrupted by user for tool use] → variant: tool', () => {
    expect(matchInterruptMarker('[Request interrupted by user for tool use]')).toEqual({
      variant: 'tool',
    })
  })

  test('前后容忍空白', () => {
    expect(matchInterruptMarker('  [Request interrupted by user]  ')).toEqual({ variant: 'user' })
    expect(matchInterruptMarker('\n[Request interrupted by user for tool use]\n')).toEqual({
      variant: 'tool',
    })
  })

  test('嵌入在更长文本里的同名子串不命中（避免误伤真实用户输入）', () => {
    expect(matchInterruptMarker('I said [Request interrupted by user] then left')).toBeNull()
    expect(matchInterruptMarker('[Request interrupted by user] and more')).toBeNull()
    expect(matchInterruptMarker('prefix [Request interrupted by user for tool use]')).toBeNull()
  })

  test('普通用户输入不命中', () => {
    expect(matchInterruptMarker('请帮我重构这段代码')).toBeNull()
    expect(matchInterruptMarker('')).toBeNull()
    expect(matchInterruptMarker('Request interrupted by user')).toBeNull() // 缺 []
    expect(matchInterruptMarker('[request interrupted by user]')).toBeNull() // 大小写不同
    expect(matchInterruptMarker('[Request interrupted]')).toBeNull() // 缺 "by user"
  })
})
