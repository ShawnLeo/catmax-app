import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useImagePreviewStore } from '@renderer/stores/image-preview'

/**
 * Image Preview Overlay store: 单例状态机——open/close/next/prev/setIndex。
 * 只覆盖交互语义（数据 + 索引），不测渲染。
 */
describe('image-preview store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('open 设置整组图片、起始索引并置为可见', () => {
    const store = useImagePreviewStore()
    store.open([{ url: 'data:1' }, { url: 'data:2' }, { url: 'data:3' }], 1)

    expect(store.visible).toBe(true)
    expect(store.total).toBe(3)
    expect(store.index).toBe(1)
    expect(store.current?.url).toBe('data:2')
  })

  it('startIndex 越界时夹紧到末尾', () => {
    const store = useImagePreviewStore()
    store.open([{ url: 'data:1' }], 99)
    expect(store.index).toBe(0)
  })

  it('open 传空数组时不打开', () => {
    const store = useImagePreviewStore()
    store.open([], 0)
    expect(store.visible).toBe(false)
  })

  it('next/prev 在多图间循环切换', () => {
    const store = useImagePreviewStore()
    store.open([{ url: 'a' }, { url: 'b' }, { url: 'c' }], 0)

    store.next()
    expect(store.index).toBe(1)
    store.next()
    expect(store.index).toBe(2)
    // 循环回第一张
    store.next()
    expect(store.index).toBe(0)

    store.prev()
    // 循环到最后一张
    expect(store.index).toBe(2)
  })

  it('单图时 next/prev 不移动索引', () => {
    const store = useImagePreviewStore()
    store.open([{ url: 'only' }], 0)
    store.next()
    expect(store.index).toBe(0)
    store.prev()
    expect(store.index).toBe(0)
  })

  it('close 隐藏 overlay 但保留数据', () => {
    const store = useImagePreviewStore()
    store.open([{ url: 'a' }, { url: 'b' }], 1)
    store.close()
    expect(store.visible).toBe(false)
    // 数据仍保留，便于下次 open 前的兜底
    expect(store.total).toBe(2)
  })

  it('setIndex 仅接受合法索引', () => {
    const store = useImagePreviewStore()
    store.open([{ url: 'a' }, { url: 'b' }], 0)

    store.setIndex(1)
    expect(store.index).toBe(1)
    // 越界忽略
    store.setIndex(5)
    expect(store.index).toBe(1)
    store.setIndex(-1)
    expect(store.index).toBe(1)
  })

  it('visible=false 时 current 为 null', () => {
    const store = useImagePreviewStore()
    store.open([{ url: 'a' }], 0)
    store.close()
    expect(store.current).toBeNull()
  })
})
