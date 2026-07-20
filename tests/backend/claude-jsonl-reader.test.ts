// @vitest-environment node
/**
 * Bug E-2 + 新 jsonl-reader 测试：
 *
 * ClaudeAdapter.getHistory 现在直接读 ~/.claude/projects/<encoded-cwd>/<id>.jsonl，
 * 不再 spawn claude。原因：
 * - `claude --resume <id>` 不带 stdin 时报 "No deferred tool marker found" 退出
 * - jsonl 是 claude 自己的持久化格式，包含完整历史 + aiTitle
 *
 * 这些测试用临时目录模拟 jsonl 文件，验证：
 * - 文件不存在 → 返回 null（adapter 上层抛错）
 * - 正常解析 user(string content) / assistant(list content) → NormalizedMessage
 * - 提取 aiTitle
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test, afterEach } from 'vitest'

import {
  encodeCwdToProjectDir,
  readClaudeSessionJsonl,
  readHistoryFromJsonl,
  resolveSessionJsonlPath,
} from '@main/backend/claude/jsonl-reader'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

/** 在临时 ~/.claude/projects 目录下生成一个假 session jsonl */
function setupFakeClaudeHome(sessionId: string, cwd: string, lines: string[]): string {
  // 临时 HOME，让 jsonl-reader 在我们造的目录里找文件
  const fakeHome = mkdtempSync(join(tmpdir(), 'claude-home-'))
  tempDirs.push(fakeHome)
  process.env.HOME = fakeHome

  const projectDir = join(fakeHome, '.claude', 'projects', encodeCwdToProjectDir(cwd))
  mkdirSync(projectDir, { recursive: true })
  const filePath = join(projectDir, `${sessionId}.jsonl`)
  writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
  return filePath
}

describe('encodeCwdToProjectDir', () => {
  test('把绝对路径的 / 换成 -', () => {
    expect(encodeCwdToProjectDir('/Users/shawn/foo')).toBe('-Users-shawn-foo')
    expect(encodeCwdToProjectDir('/tmp')).toBe('-tmp')
  })
})

describe('resolveSessionJsonlPath', () => {
  test('组合 ~/.claude/projects/<encoded>/<id>.jsonl', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'h-'))
    tempDirs.push(fakeHome)
    process.env.HOME = fakeHome
    const p = resolveSessionJsonlPath('sess-123', '/Users/x/demo')
    expect(p).toBe(join(fakeHome, '.claude', 'projects', '-Users-x-demo', 'sess-123.jsonl'))
  })
})

describe('readClaudeSessionJsonl', () => {
  test('文件不存在 → 返回 null', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'h-'))
    tempDirs.push(fakeHome)
    process.env.HOME = fakeHome
    const result = await readClaudeSessionJsonl('missing-id', '/some/cwd')
    expect(result).toBeNull()
  })

  test('解析 user(string content) + assistant(thinking+text) + ai-title', async () => {
    const lines = [
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content: '记住数字 42',
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '记住数字 42' }, // ← string 形式
      }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Remember 42' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: '用户让我记 42' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: '好的，记住了。' }],
        },
      }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: '记住数字 42' }), // 应被忽略
      JSON.stringify({ type: 'attachment', attachment: {} }), // 应被忽略
    ]
    setupFakeClaudeHome('sess-A', '/test/cwd', lines)

    const result = await readClaudeSessionJsonl('sess-A', '/test/cwd')
    expect(result).not.toBeNull()
    expect(result?.aiTitle).toBe('Remember 42')
    // 1 user + 2 assistant（thinking 和 text 分两条 jsonl）
    expect(result?.messages.length).toBe(3)
    expect(result?.messages[0]?.type).toBe('user')
    expect(result?.messages[1]?.type).toBe('assistant')
    expect(result?.messages[2]?.type).toBe('assistant')
  })

  test('跳过损坏的 JSON 行（不抛错）', async () => {
    const lines = [
      '{not valid json',
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      'another broken line',
    ]
    setupFakeClaudeHome('sess-B', '/test/cwd', lines)

    const result = await readClaudeSessionJsonl('sess-B', '/test/cwd')
    expect(result?.messages.length).toBe(1)
  })
})

describe('readHistoryFromJsonl（Bug E-2 端到端验证）', () => {
  test('把 jsonl 转成 NormalizedMessage[]，user 在前 assistant 在后', async () => {
    const lines = [
      JSON.stringify({ type: 'ai-title', aiTitle: 'Demo chat' }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hello' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg-1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'hi there' }],
        },
      }),
    ]
    setupFakeClaudeHome('sess-C', '/demo', lines)

    const result = await readHistoryFromJsonl('sess-C', '/demo')
    expect(result).not.toBeNull()
    expect(result?.aiTitle).toBe('Demo chat')

    const msgs = result?.messages ?? []
    expect(msgs.length).toBe(2)
    expect(msgs[0]?.role).toBe('user')
    expect(msgs[0]?.textBlocks?.[0]?.text).toBe('hello')
    expect(msgs[1]?.role).toBe('assistant')
    expect(msgs[1]?.textBlocks?.[0]?.text).toBe('hi there')
  })
})

describe('ClaudeAdapter.getHistory 集成（Bug E-2）', () => {
  test('jsonl 不存在时抛错（不再静默返空数组）', async () => {
    const { ClaudeAdapter } = await import('@main/backend/claude/adapter')
    const adapter = new ClaudeAdapter()

    // 用一个绝对不存在的 cwd
    await expect(adapter.getHistory('nonexistent-id', '/definitely/not/exist')).rejects.toThrow(
      /session jsonl not found/,
    )
  })

  test('正常读取 → 返回 NormalizedMessage[]', async () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'ping' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'pong' }],
        },
      }),
    ]
    setupFakeClaudeHome('sess-D', '/cwd-D', lines)

    const { ClaudeAdapter } = await import('@main/backend/claude/adapter')
    const adapter = new ClaudeAdapter()
    const { messages } = await adapter.getHistory('sess-D', '/cwd-D')
    expect(messages.length).toBe(2)
    expect(messages[0]?.role).toBe('user')
    expect(messages[1]?.role).toBe('assistant')
    expect(messages[1]?.textBlocks?.[0]?.text).toBe('pong')
  })

  test('Bug F-1：aiTitle 从 jsonl 提取并随 getHistory 返回', async () => {
    const lines = [
      JSON.stringify({ type: 'ai-title', aiTitle: 'Auto-gen title' }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hello' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
        },
      }),
    ]
    setupFakeClaudeHome('sess-E', '/cwd-E', lines)

    const { ClaudeAdapter } = await import('@main/backend/claude/adapter')
    const adapter = new ClaudeAdapter()
    const result = await adapter.getHistory('sess-E', '/cwd-E')
    expect(result.aiTitle).toBe('Auto-gen title')
    expect(result.messages.length).toBe(2)
  })

  test('Bug F-1：jsonl 没有 ai-title 行时 aiTitle 为 null', async () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'no title session' },
      }),
    ]
    setupFakeClaudeHome('sess-F', '/cwd-F', lines)

    const { ClaudeAdapter } = await import('@main/backend/claude/adapter')
    const adapter = new ClaudeAdapter()
    const result = await adapter.getHistory('sess-F', '/cwd-F')
    expect(result.aiTitle).toBeNull()
  })
})
