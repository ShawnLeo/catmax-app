// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from 'vitest'

const sdkMocks = vi.hoisted(() => ({
  deleteSession: vi.fn(async () => {}),
  query: vi.fn((_params: unknown) => ({
    async *[Symbol.asyncIterator]() {},
    initializationResult: vi.fn(async () => ({ models: [] })),
  })),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  deleteSession: sdkMocks.deleteSession,
  query: sdkMocks.query,
}))
vi.mock('electron', () => ({
  app: { isPackaged: false },
}))

const { ClaudeAdapter } = await import('@main/backend/claude/adapter')

describe('ClaudeAdapter warmup', () => {
  beforeEach(() => {
    sdkMocks.deleteSession.mockClear()
    sdkMocks.query.mockClear()
  })

  test('使用独立临时 session，完成后删除 transcript', async () => {
    const adapter = new ClaudeAdapter()

    await adapter.warmup({ cwd: '/tmp/project', model: 'sonnet', effort: 'medium' })

    expect(sdkMocks.query).toHaveBeenCalledTimes(1)
    const call = sdkMocks.query.mock.calls[0]![0] as {
      prompt: string
      options: { cwd: string; model: string; sessionId: string }
    }
    expect(call.prompt).toBe('Warmup. Reply with exactly "ready" and do not use any tools.')
    expect(call.options.cwd).toBe('/tmp/project')
    expect(call.options.model).toBe('sonnet')
    expect(call.options.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(sdkMocks.deleteSession).toHaveBeenCalledWith(call.options.sessionId, {
      dir: '/tmp/project',
    })
  })

  test('相同 cwd/model/effort 在 TTL 内只执行一次', async () => {
    const adapter = new ClaudeAdapter()
    const args = { cwd: '/tmp/project', model: 'sonnet', effort: 'medium' as const }

    await Promise.all([adapter.warmup(args), adapter.warmup(args)])
    await adapter.warmup(args)

    expect(sdkMocks.query).toHaveBeenCalledTimes(1)
    expect(sdkMocks.deleteSession).toHaveBeenCalledTimes(1)
  })

  test('不同模型分别预热', async () => {
    const adapter = new ClaudeAdapter()

    await adapter.warmup({ cwd: '/tmp/project', model: 'sonnet' })
    await adapter.warmup({ cwd: '/tmp/project', model: 'opus' })

    expect(sdkMocks.query).toHaveBeenCalledTimes(2)
    expect(sdkMocks.deleteSession).toHaveBeenCalledTimes(2)
  })
})
