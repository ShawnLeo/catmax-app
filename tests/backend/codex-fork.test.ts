import { homedir } from 'node:os'
import { join } from 'node:path'

import { codexRolloutPath, rewriteSessionMetaLine, uuidV7 } from '@main/backend/codex/adapter'
import { describe, expect, test } from 'vitest'

/**
 * Session Fork（codex）：codex 没有 fork RPC，复制会话是在 rollout 文件层面做的。
 * 这里测的是那套改写逻辑对 codex 磁盘格式的三个推断。
 */
describe('codex fork: uuidV7', () => {
  test('前 48 bit 是毫秒时间戳，版本位是 7', () => {
    const now = new Date('2026-08-01T10:20:30.400Z')
    const id = uuidV7(now)

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    // 前 12 个 hex 位 = 48 bit 毫秒时间戳
    const timestampHex = id.replace(/-/g, '').slice(0, 12)
    expect(parseInt(timestampHex, 16)).toBe(now.getTime())
  })

  test('时间递增则 id 字典序递增——codex 原生 UI 按 id 排序才不会乱', () => {
    const earlier = uuidV7(new Date('2026-08-01T10:00:00.000Z'))
    const later = uuidV7(new Date('2026-08-01T10:00:01.000Z'))
    expect(earlier < later).toBe(true)
  })

  test('同一毫秒生成两次不会撞', () => {
    const now = new Date('2026-08-01T10:20:30.400Z')
    expect(uuidV7(now)).not.toBe(uuidV7(now))
  })
})

describe('codex fork: codexRolloutPath', () => {
  test('日期目录与文件名用本地时间——用 UTC 会在跨日时段放错目录', () => {
    // 构造一个"本地时间"明确的时刻，避免测试机时区不同导致断言飘
    const now = new Date(2026, 7, 1, 19, 46, 14) // 2026-08-01 19:46:14 本地
    const path = codexRolloutPath(now, '019c13e0-0410-70e1-ac0f-bee6fbdf5a16')

    expect(path).toBe(
      join(
        homedir(),
        '.codex',
        'sessions',
        '2026',
        '08',
        '01',
        'rollout-2026-08-01T19-46-14-019c13e0-0410-70e1-ac0f-bee6fbdf5a16.jsonl',
      ),
    )
  })

  test('月/日/时分秒补零', () => {
    const now = new Date(2026, 0, 5, 3, 4, 5)
    expect(codexRolloutPath(now, 'tid')).toContain(join('2026', '01', '05'))
    expect(codexRolloutPath(now, 'tid')).toContain('rollout-2026-01-05T03-04-05-tid.jsonl')
  })
})

describe('codex fork: rewriteSessionMetaLine', () => {
  const now = new Date('2026-08-01T10:20:30.400Z')

  test('换 thread id + 时间戳，其余字段原样保留', () => {
    const line = JSON.stringify({
      timestamp: '2026-01-31T11:46:14.171Z',
      type: 'session_meta',
      payload: {
        id: '019c13e0-0410-70e1-ac0f-bee6fbdf5a16',
        timestamp: '2026-01-31T11:46:14.161Z',
        cwd: '/Users/me/proj',
        // 这两个决定 fork 出的会话跑在什么配置下，丢了就是另一个会话了
        model_provider: 'catmax-bridge',
        base_instructions: { text: 'You are Codex' },
      },
    })

    const rewritten = JSON.parse(rewriteSessionMetaLine(line, 'new-thread-id', now)) as {
      timestamp: string
      type: string
      payload: Record<string, unknown>
    }

    expect(rewritten.payload.id).toBe('new-thread-id')
    expect(rewritten.payload.timestamp).toBe(now.toISOString())
    expect(rewritten.timestamp).toBe(now.toISOString())
    expect(rewritten.type).toBe('session_meta')
    expect(rewritten.payload.cwd).toBe('/Users/me/proj')
    expect(rewritten.payload.model_provider).toBe('catmax-bridge')
    expect(rewritten.payload.base_instructions).toEqual({ text: 'You are Codex' })
  })

  test('首行不是 session_meta 时原样返回，不塞进乱七八糟的 JSON', () => {
    const line = JSON.stringify({ type: 'response_item', payload: { type: 'message' } })
    expect(rewriteSessionMetaLine(line, 'new-id', now)).toBe(line)
  })

  test('首行不是合法 JSON 时原样返回', () => {
    expect(rewriteSessionMetaLine('{ not json', 'new-id', now)).toBe('{ not json')
  })

  test('session_meta 缺 payload 时原样返回', () => {
    const line = JSON.stringify({ type: 'session_meta' })
    expect(rewriteSessionMetaLine(line, 'new-id', now)).toBe(line)
  })
})
