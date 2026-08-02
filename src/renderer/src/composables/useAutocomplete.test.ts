import { charTrigger, SuggestionRegistry, type SuggestionItem } from '@renderer/lib/autocomplete'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'

import { useAutocomplete } from './useAutocomplete'

function item(label: string, insert: string, keepOpen = false): SuggestionItem {
  return { id: label, label, insert, ...(keepOpen && { keepOpen: true }) }
}

/** 用 effectScope 跑，composable 的 onScopeDispose 才有归属（不必挂真组件）。 */
function setup(search: (query: string) => Promise<SuggestionItem[]>) {
  const registry = new SuggestionRegistry()
  registry.register({
    id: 'test',
    detect: charTrigger({ char: '@' }),
    search: (match) => search(match.query),
    emptyText: '没有匹配的文件',
  })
  const applied: Array<{ text: string; caret: number }> = []
  const scope = effectScope()
  const api = scope.run(() =>
    useAutocomplete({
      registry,
      context: () => ({ workspaceId: 'ws-1' }),
      onApply: (text, caret) => applied.push({ text, caret }),
    }),
  )!
  return { api, applied, dispose: () => scope.stop() }
}

/** 走完防抖 + 让 provider 的 promise 落地。 */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(200)
}

function keydown(key: string, extra: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    shiftKey: false,
    isComposing: false,
    preventDefault: vi.fn(),
    ...extra,
  } as unknown as KeyboardEvent
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useAutocomplete', () => {
  it('落在触发段里才打开，离开就关', async () => {
    const { api, dispose } = setup(async () => [item('a.ts', '@a.ts ')])

    api.refresh('@a', 2)
    expect(api.open.value).toBe(true)
    await settle()
    expect(api.items.value).toHaveLength(1)

    api.refresh('普通文本', 4)
    expect(api.open.value).toBe(false)
    expect(api.items.value).toEqual([])
    dispose()
  })

  it('连续输入只在停下后查一次', async () => {
    const search = vi.fn(async () => [item('a.ts', '@a.ts ')])
    const { api, dispose } = setup(search)

    api.refresh('@a', 2)
    api.refresh('@ab', 3)
    api.refresh('@abc', 4)
    await settle()

    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith('abc')
    dispose()
  })

  /*
   * 竞态：慢的旧请求晚回来会盖掉新结果，表现为「输入框里是 ab，列表却是 a 的结果」。
   * 这里让第一次搜索故意慢一拍，钉住旧结果不许写进列表。
   */
  it('慢的旧请求回来时不许覆盖新结果', async () => {
    const { api, dispose } = setup(async (query) => {
      if (query === 'a') {
        await new Promise((resolve) => setTimeout(resolve, 500))
        return [item('旧结果', '@old ')]
      }
      return [item('新结果', '@new ')]
    })

    api.refresh('@a', 2)
    await vi.advanceTimersByTimeAsync(130) // 防抖过了，慢请求已发出
    api.refresh('@ab', 3)
    await vi.advanceTimersByTimeAsync(1000) // 两个请求都落地了

    expect(api.items.value.map((i) => i.label)).toEqual(['新结果'])
    dispose()
  })

  it('↑↓ 循环选择，Enter 应用当前项', async () => {
    const { api, applied, dispose } = setup(async () => [
      item('a.ts', '@a.ts '),
      item('b.ts', '@b.ts '),
    ])

    api.refresh('看 @b', 4)
    await settle()

    expect(api.handleKeydown(keydown('ArrowDown'))).toBe(true)
    expect(api.activeIndex.value).toBe(1)
    // 循环：最后一项再往下回到第一项
    api.handleKeydown(keydown('ArrowDown'))
    expect(api.activeIndex.value).toBe(0)
    api.handleKeydown(keydown('ArrowUp'))
    expect(api.activeIndex.value).toBe(1)

    expect(api.handleKeydown(keydown('Enter'))).toBe(true)
    expect(applied).toEqual([{ text: '看 @b.ts ', caret: 8 }])
    expect(api.open.value).toBe(false)
    dispose()
  })

  it('Shift+Enter 和输入法组合中一律不抢键', async () => {
    const { api, dispose } = setup(async () => [item('a.ts', '@a.ts ')])
    api.refresh('@a', 2)
    await settle()

    expect(api.handleKeydown(keydown('Enter', { shiftKey: true }))).toBe(false)
    expect(api.handleKeydown(keydown('Enter', { isComposing: true }))).toBe(false)
    expect(api.handleKeydown(keydown('ArrowDown', { isComposing: true }))).toBe(false)
    dispose()
  })

  it('列表为空时不拦 Enter——否则消息发不出去且看不出被谁挡住', async () => {
    const { api, dispose } = setup(async () => [])
    api.refresh('@zzz', 4)
    await settle()

    expect(api.open.value).toBe(true)
    expect(api.handleKeydown(keydown('Enter'))).toBe(false)
    dispose()
  })

  /*
   * 回归测试。Esc 之后输入框还会再报一次光标位置（keyup 触发），光标仍停在同一个
   * `@…` 里——不记住「这一段已经关过」的话弹层会立刻自己弹回来，Esc 形同虚设。
   */
  it('Esc 关掉后，同一个触发段不会因为光标事件又弹回来', async () => {
    const { api, dispose } = setup(async () => [item('a.ts', '@a.ts ')])
    api.refresh('@a', 2)
    await settle()

    expect(api.handleKeydown(keydown('Escape'))).toBe(true)
    expect(api.open.value).toBe(false)

    api.refresh('@a', 2)
    expect(api.open.value).toBe(false)

    // 继续输入 = 换了一段，应该重新开始联想
    api.refresh('@ab', 3)
    expect(api.open.value).toBe(true)
    dispose()
  })

  it('keepOpen 的候选（目录）应用后继续联想下一层', async () => {
    const seen: string[] = []
    const { api, applied, dispose } = setup(async (query) => {
      seen.push(query)
      return query.endsWith('/') ? [item('lib', '@src/lib/', true)] : [item('src', '@src/', true)]
    })

    api.refresh('@s', 2)
    await settle()
    api.handleKeydown(keydown('Enter'))

    expect(applied).toEqual([{ text: '@src/', caret: 5 }])
    expect(api.open.value).toBe(true)
    await settle()
    expect(seen).toEqual(['s', 'src/'])
    dispose()
  })
})
