import {
  agentMessageDeltaParamsSchema,
  codexItemSchema,
  commandApprovalParamsSchema,
  jsonRpcMessageSchema,
  turnCompletedParamsSchema,
  turnStartedParamsSchema,
} from '@shared/backend/schema'
import { describe, expect, test } from 'vitest'

describe('codex JSON-RPC schema', () => {
  test('JSON-RPC notification 解析', () => {
    const msg = {
      method: 'turn/started',
      params: { turn: { id: 't1', status: 'in_progress', items: [] } },
    }
    const result = jsonRpcMessageSchema.safeParse(msg)
    expect(result.success).toBe(true)
  })

  test('JSON-RPC request 解析（带 id）', () => {
    const msg = {
      method: 'initialize',
      id: 1,
      params: { clientInfo: { name: 'catmax', version: '0.1.0' } },
    }
    const result = jsonRpcMessageSchema.safeParse(msg)
    expect(result.success).toBe(true)
  })

  test('JSON-RPC response 解析（带 id + result）', () => {
    const msg = { id: 1, result: { ok: true } }
    const result = jsonRpcMessageSchema.safeParse(msg)
    expect(result.success).toBe(true)
  })

  test('JSON-RPC error response', () => {
    const msg = { id: 1, error: { code: -32600, message: 'bad request' } }
    const result = jsonRpcMessageSchema.safeParse(msg)
    expect(result.success).toBe(true)
  })

  test('agentMessage/delta 解析', () => {
    const params = { itemId: 'item_1', delta: 'hello world' }
    expect(agentMessageDeltaParamsSchema.safeParse(params).success).toBe(true)
  })

  test('commandExecution item 解析', () => {
    const item = {
      type: 'command_execution',
      id: 'cmd_1',
      command: 'git status',
      cwd: '/tmp',
      status: 'in_progress',
    }
    expect(codexItemSchema.safeParse(item).success).toBe(true)
  })

  test('file_change item 解析', () => {
    const item = {
      type: 'file_change',
      id: 'fc_1',
      changes: [{ path: '/tmp/test.ts', kind: 'edit', diff: '@@ ...' }],
      status: 'in_progress',
    }
    expect(codexItemSchema.safeParse(item).success).toBe(true)
  })

  test('未知 item 类型用 passthrough 接住（不阻塞流）', () => {
    const item = {
      type: 'some_new_future_item',
      id: 'x_1',
      customField: 'whatever',
    }
    expect(codexItemSchema.safeParse(item).success).toBe(true)
  })

  test('commandApproval 解析', () => {
    const params = {
      itemId: 'cmd_1',
      threadId: 'thr_1',
      turnId: 'turn_1',
      command: 'rm -rf /',
      cwd: '/tmp',
      availableDecisions: ['accept', 'decline'],
    }
    expect(commandApprovalParamsSchema.safeParse(params).success).toBe(true)
  })

  test('turnStarted 解析（items 默认空数组）', () => {
    const params = { turn: { id: 'turn_1', status: 'in_progress' } }
    const result = turnStartedParamsSchema.safeParse(params)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.turn.items).toEqual([])
    }
  })

  test('turnCompleted 解析', () => {
    const params = {
      turn: { id: 'turn_1', status: 'completed', items: [] },
    }
    expect(turnCompletedParamsSchema.safeParse(params).success).toBe(true)
  })

  test('turnCompleted failed 状态合法', () => {
    const params = {
      turn: { id: 'turn_1', status: 'failed', items: [], error: { message: 'oops' } },
    }
    expect(turnCompletedParamsSchema.safeParse(params).success).toBe(true)
  })
})
