import {
  agentMessageDeltaParamsSchema,
  codexItemSchema,
  codexUserInputSchema,
  commandApprovalParamsSchema,
  commandExecutionOutputDeltaParamsSchema,
  fileChangePatchUpdatedParamsSchema,
  jsonRpcMessageSchema,
  turnCompletedParamsSchema,
  turnStartedParamsSchema,
  turnDiffUpdatedParamsSchema,
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

  test('agentMessage item 保留 commentary/final_answer phase', () => {
    const result = codexItemSchema.safeParse({
      type: 'agentMessage',
      id: 'item_1',
      text: 'working',
      phase: 'commentary',
    })
    expect(result.success).toBe(true)
    if (result.success && 'phase' in result.data) expect(result.data.phase).toBe('commentary')
  })

  test('Codex UserInput 支持当前五种官方输入和旧 input_* 形态', () => {
    const inputs = [
      { type: 'text', text: 'hello', text_elements: [] },
      { type: 'image', url: 'https://example.com/image.png', detail: 'high' },
      { type: 'localImage', path: '/tmp/image.png' },
      { type: 'skill', name: 'openai-docs', path: '/tmp/SKILL.md' },
      { type: 'mention', name: 'README.md', path: '/repo/README.md' },
      { type: 'input_text', text: 'legacy' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    ]
    expect(inputs.every((input) => codexUserInputSchema.safeParse(input).success)).toBe(true)

    const message = codexItemSchema.safeParse({
      type: 'userMessage',
      id: 'user-1',
      clientId: 'client-1',
      content: inputs,
    })
    expect(message.success).toBe(true)
    if (message.success && 'content' in message.data) {
      expect(message.data.content).toHaveLength(inputs.length)
    }
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

  test('当前 app-server camelCase item 与实时 patch/diff 事件可解析', () => {
    expect(
      codexItemSchema.safeParse({
        type: 'commandExecution',
        id: 'cmd_1',
        command: 'rg foo src',
        cwd: '/tmp',
        status: 'inProgress',
        commandActions: [{ type: 'search', command: 'rg foo src', query: 'foo', path: 'src' }],
      }).success,
    ).toBe(true)
    expect(
      commandExecutionOutputDeltaParamsSchema.safeParse({
        itemId: 'cmd_1',
        delta: 'one line',
      }).success,
    ).toBe(true)
    expect(
      fileChangePatchUpdatedParamsSchema.safeParse({
        itemId: 'patch_1',
        changes: [
          {
            path: '/tmp/a.ts',
            kind: { type: 'update', move_path: null },
            diff: '@@ -1 +1 @@\n-old\n+new',
          },
        ],
      }).success,
    ).toBe(true)
    expect(turnDiffUpdatedParamsSchema.safeParse({ diff: '+new\n-old' }).success).toBe(true)
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
