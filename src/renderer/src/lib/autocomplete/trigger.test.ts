import { describe, expect, it } from 'vitest'

import { charTrigger } from './trigger'

const at = charTrigger({ char: '@' })

describe('charTrigger — @ 文件引用', () => {
  it('光标紧跟触发字符时给出空 query', () => {
    expect(at('@', 1)).toEqual({ char: '@', start: 0, end: 1, query: '' })
  })

  it('取触发字符到光标之间的文本作为 query', () => {
    expect(at('看看 @src/a', 9)).toMatchObject({ start: 3, query: 'src/a' })
  })

  it('光标在 token 中间时 query 只到光标为止——用户可能在往回改', () => {
    expect(at('@src/abc', 4)).toMatchObject({ start: 0, query: 'src' })
  })

  /*
   * 这条是整个联想里最要紧的一条规则，跟 file-mention.ts 的 MENTION_RE 前导
   * `(^|\s)` 是同一条。放开的话，打邮箱地址的每一个字符都会弹一次文件列表。
   */
  it('触发字符前面不是空白就不算触发', () => {
    expect(at('foo@bar', 7)).toBeNull()
    expect(at('user@host', 9)).toBeNull()
  })

  it('前面是空白或行首都算', () => {
    expect(at('@a', 2)).not.toBeNull()
    expect(at('x @a', 4)).not.toBeNull()
    expect(at('x\n@a', 4)).not.toBeNull()
  })

  it('query 里出现空白就结束触发——否则打完 @ 之后整句话都是查询词', () => {
    expect(at('@src/a 然后呢', 10)).toBeNull()
  })

  it('不跨行——上一行的 @ 不该粘住下一行', () => {
    expect(at('@src\nfoo', 8)).toBeNull()
  })

  it('光标退到触发字符之前就不再是触发段', () => {
    expect(at('@src', 0)).toBeNull()
  })

  it('query 超过长度上限就放弃，避免弹层一直挂着', () => {
    const short = charTrigger({ char: '@', maxQueryLength: 4 })
    expect(short('@abcd', 5)).not.toBeNull()
    expect(short('@abcde', 6)).toBeNull()
  })
})

describe('charTrigger — 斜杠命令的规则（下一期用，先钉住扩展点）', () => {
  const slash = charTrigger({ char: '/', atTextStart: true })

  it('只在文本最开头触发', () => {
    expect(slash('/comp', 5)).toMatchObject({ char: '/', start: 0, query: 'comp' })
  })

  it('句中的斜杠不触发——and/or、路径分隔符都会撞上', () => {
    expect(slash('and/or', 6)).toBeNull()
    expect(slash(' /compact', 9)).toBeNull()
  })
})
