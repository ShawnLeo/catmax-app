import {
  LineBuffer,
  classifyMessage,
  encodeNotification,
  encodeRequest,
  encodeResponse,
  parseFrame,
} from '@main/backend/codex/protocol'
import { describe, expect, test } from 'vitest'

describe('LineBuffer', () => {
  test('单行完整 chunk', () => {
    const lb = new LineBuffer()
    expect(lb.push('{"a":1}\n')).toEqual(['{"a":1}'])
  })

  test('跨 chunk 的不完整行', () => {
    const lb = new LineBuffer()
    expect(lb.push('{"a":')).toEqual([])
    expect(lb.push('1}\n')).toEqual(['{"a":1}'])
  })

  test('多行一个 chunk', () => {
    const lb = new LineBuffer()
    expect(lb.push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}'])
  })

  test('空行被忽略', () => {
    const lb = new LineBuffer()
    expect(lb.push('\n\n{"a":1}\n\n')).toEqual(['{"a":1}'])
  })

  test('flush 取剩余', () => {
    const lb = new LineBuffer()
    lb.push('{"a":1}\n{"b":')
    expect(lb.flush()).toBe('{"b":')
    expect(lb.flush()).toBeNull()
  })

  test('Buffer 类型输入', () => {
    const lb = new LineBuffer()
    expect(lb.push(Buffer.from('{"a":1}\n'))).toEqual(['{"a":1}'])
  })
})

describe('parseFrame', () => {
  test('合法 JSON-RPC notification', () => {
    const msg = parseFrame('{"method":"turn/started","params":{}}')
    expect(msg).not.toBeNull()
  })

  test('空行返回 null', () => {
    expect(parseFrame('')).toBeNull()
    expect(parseFrame('   ')).toBeNull()
  })

  test('非法 JSON 返回 null（不抛错）', () => {
    expect(parseFrame('{ not json')).toBeNull()
  })

  test('schema 校验失败返回 null', () => {
    expect(parseFrame('[1,2,3]')).toBeNull()
  })
})

describe('classifyMessage', () => {
  test('识别 server-request（有 method + id）', () => {
    const msg = parseFrame(
      '{"method":"item/commandExecution/requestApproval","id":10,"params":{}}',
    )!
    const classified = classifyMessage(msg)
    expect(classified?.kind).toBe('server-request')
  })

  test('识别 response（有 id 无 method）', () => {
    const msg = parseFrame('{"id":1,"result":{"ok":true}}')!
    const classified = classifyMessage(msg)
    expect(classified?.kind).toBe('response')
  })

  test('识别 notification（有 method 无 id）', () => {
    const msg = parseFrame('{"method":"turn/started","params":{}}')!
    const classified = classifyMessage(msg)
    expect(classified?.kind).toBe('notification')
  })
})

describe('encode', () => {
  test('encodeRequest 含 id', () => {
    const json = encodeRequest(
      'initialize',
      { clientInfo: { name: 'catmax', version: '0.1.0' } },
      1,
    )
    const parsed = JSON.parse(json)
    expect(parsed.method).toBe('initialize')
    expect(parsed.id).toBe(1)
    expect(parsed.params.clientInfo.name).toBe('catmax')
  })

  test('encodeNotification 无 id', () => {
    const json = encodeNotification('initialized', {})
    const parsed = JSON.parse(json)
    expect(parsed.method).toBe('initialized')
    expect(parsed.id).toBeUndefined()
  })

  test('encodeResponse', () => {
    const json = encodeResponse(10, { decision: 'accept' })
    const parsed = JSON.parse(json)
    expect(parsed.id).toBe(10)
    expect(parsed.result.decision).toBe('accept')
  })
})
