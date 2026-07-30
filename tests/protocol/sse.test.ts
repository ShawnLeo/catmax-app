// @vitest-environment node
import { encodeSseFrame, SseParser } from '@main/protocol/sse'
import { describe, expect, test } from 'vitest'

describe('SseParser', () => {
  test('一个 chunk 里的多个事件全部切出来', () => {
    const parser = new SseParser()
    const frames = parser.push(
      Buffer.from('event: a\ndata: {"x":1}\n\nevent: b\ndata: {"x":2}\n\n'),
    )
    expect(frames).toEqual([
      { event: 'a', data: '{"x":1}' },
      { event: 'b', data: '{"x":2}' },
    ])
  })

  test('事件被切在两个 chunk 中间时不丢', () => {
    const parser = new SseParser()
    expect(parser.push(Buffer.from('event: a\ndata: {"x"'))).toEqual([])
    expect(parser.push(Buffer.from(':1}\n\n'))).toEqual([{ event: 'a', data: '{"x":1}' }])
  })

  test('多字节字符被切在两个 chunk 中间时不产生替换字符', () => {
    const parser = new SseParser()
    const payload = Buffer.from('data: {"t":"中文"}\n\n', 'utf-8')
    // 在「中」的 UTF-8 三字节中间切开
    const cut = payload.indexOf(Buffer.from('中', 'utf-8')) + 1
    expect(parser.push(payload.subarray(0, cut))).toEqual([])
    const frames = parser.push(payload.subarray(cut))
    expect(frames).toEqual([{ event: undefined, data: '{"t":"中文"}' }])
  })

  test('认 CRLF 分隔', () => {
    const parser = new SseParser()
    expect(parser.push(Buffer.from('event: a\r\ndata: 1\r\n\r\n'))).toEqual([
      { event: 'a', data: '1' },
    ])
  })

  test('多行 data 用 \\n 拼接，注释行忽略', () => {
    const parser = new SseParser()
    expect(parser.push(Buffer.from(': keep-alive\ndata: line1\ndata: line2\n\n'))).toEqual([
      { event: undefined, data: 'line1\nline2' },
    ])
  })

  test('data: 后只吃掉一个前导空格', () => {
    const parser = new SseParser()
    expect(parser.push(Buffer.from('data:  two-spaces\n\n'))).toEqual([
      { event: undefined, data: ' two-spaces' },
    ])
  })

  test('finish 冲刷掉没有结尾空行的残留事件', () => {
    const parser = new SseParser()
    expect(parser.push(Buffer.from('data: tail'))).toEqual([])
    expect(parser.finish()).toEqual([{ event: undefined, data: 'tail' }])
  })

  test('encodeSseFrame 产出标准 event/data 帧', () => {
    expect(encodeSseFrame('response.created', { a: 1 }).toString('utf-8')).toBe(
      'event: response.created\ndata: {"a":1}\n\n',
    )
  })
})
