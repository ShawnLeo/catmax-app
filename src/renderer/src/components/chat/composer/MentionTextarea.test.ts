import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'

import MentionTextarea from './MentionTextarea.vue'

describe('MentionTextarea', () => {
  test('keeps the caret line visible and the highlight layer in sync after reaching max height', async () => {
    const wrapper = mount(MentionTextarea, {
      props: { modelValue: '' },
    })
    const textarea = wrapper.get('textarea').element as HTMLTextAreaElement
    const highlightWrapper = wrapper.get('div.mirror')
    const highlight = highlightWrapper.element as HTMLElement

    expect(highlightWrapper.classes()).toContain('overflow-auto')
    expect(highlightWrapper.classes()).not.toContain('overflow-hidden')

    Object.defineProperties(textarea, {
      clientHeight: { configurable: true, value: 192 },
      scrollHeight: { configurable: true, value: 349 },
    })

    const value = `@Foo.java \n${Array.from({ length: 14 }, (_, i) => `第${i + 1}行测试内容`).join('\n')}`
    textarea.value = value
    textarea.setSelectionRange(value.length, value.length)
    await wrapper.get('textarea').trigger('input')

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([value])
    expect(textarea.style.height).toBe('192px')
    expect(textarea.style.overflowY).toBe('auto')
    expect(textarea.scrollTop).toBeGreaterThan(0)
    expect(highlight.scrollTop).toBe(textarea.scrollTop)

    // 回归真实触发路径：内容封顶后上下滚动两轮，镜像层不能逐轮漂移。
    for (const scrollTop of [0, 157, 0, 157]) {
      textarea.scrollTop = scrollTop
      await wrapper.get('textarea').trigger('scroll')
      expect(highlight.scrollTop).toBe(scrollTop)
    }
  })
})
