// @vitest-environment node
/**
 * Warmup Transcript: 预热残留识别。
 *
 * 背景：claude 的 prompt-cache 预热跑完会自己删掉 transcript，但应用被强杀时
 * finally 跑不到，jsonl 就留在 ~/.claude/projects/ 里，被扫成一条名叫
 * "Session warmup" 的历史会话混进侧边栏。
 *
 * 这里测的是"哪些文件算预热残留"这条判据——它同时决定了扫描时跳过谁、
 * 启动清理删掉谁，所以误判的代价是**删掉用户的真实会话**。宁可漏，不可错。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  encodeCwdToProjectDir,
  listClaudeSessionsFromDisk,
  listWarmupTranscripts,
} from '@main/backend/claude/jsonl-reader'
import {
  WARMUP_MARKER,
  WARMUP_PROMPT,
  isWarmupTranscript,
} from '@main/backend/claude/warmup-transcript'
import { describe, expect, test, afterEach } from 'vitest'

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

function writeJsonl(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-'))
  tempDirs.push(dir)
  const filePath = join(dir, 'transcript.jsonl')
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8')
  return filePath
}

/** 真实残留文件的形状（照着线上捞到的那份写） */
const WARMUP_LINES = [
  { type: 'queue-operation', operation: 'enqueue' },
  { type: 'queue-operation', operation: 'dequeue' },
  { type: 'user', message: { role: 'user', content: [{ type: 'text', text: WARMUP_PROMPT }] } },
  { type: 'attachment' },
  { type: 'ai-title', aiTitle: 'Session warmup' },
]

describe('isWarmupTranscript', () => {
  test('认出真实的预热残留', async () => {
    expect(await isWarmupTranscript(writeJsonl(WARMUP_LINES))).toBe(true)
  })

  test('content 是裸 string 形态也认得（jsonl 两种形态都存在）', async () => {
    const file = writeJsonl([{ type: 'user', message: { role: 'user', content: WARMUP_PROMPT } }])
    expect(await isWarmupTranscript(file)).toBe(true)
  })

  /**
   * 线上真捞到过的两份残留，措辞完全不同——识别必须同时认得这两代，
   * 否则老用户机器上的旧残留永远清不掉。
   */
  test.each([
    [
      '带标记的历史版本（"Readiness check warmup"）',
      `${WARMUP_MARKER}\nReady check. Reply with exactly one word: "ready". Do not use any tools.`,
    ],
    [
      '标记丢失的那一版（"Session warmup"）',
      'Warmup. Reply with exactly "ready" and do not use any tools.',
    ],
  ])('认得出历史残留：%s', async (_name, prompt) => {
    const file = writeJsonl([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } },
    ])
    expect(await isWarmupTranscript(file)).toBe(true)
  })

  test('措辞改了但标记还在 → 仍然认得（标记存在的意义）', async () => {
    const file = writeJsonl([
      {
        type: 'user',
        message: { role: 'user', content: `${WARMUP_MARKER}\n完全不同的措辞，甚至换成中文` },
      },
    ])
    expect(await isWarmupTranscript(file)).toBe(true)
  })

  test('普通会话不误判', async () => {
    const file = writeJsonl([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '帮我改个 bug' }] },
      },
      { type: 'assistant', message: { model: 'claude-opus-4' } },
      { type: 'ai-title', aiTitle: '修复登录问题' },
    ])
    expect(await isWarmupTranscript(file)).toBe(false)
  })

  test('只看第一条 user 消息——真实会话里出现同样的文本不算', async () => {
    const file = writeJsonl([
      { type: 'user', message: { role: 'user', content: '预热是怎么实现的？' } },
      { type: 'assistant', message: { model: 'claude-opus-4' } },
      // 比如在讨论预热机制时把那句 prompt 贴了出来
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: WARMUP_PROMPT }] } },
    ])
    expect(await isWarmupTranscript(file)).toBe(false)
  })

  test('多段 content 不算——预热发的是单段纯文本', async () => {
    const file = writeJsonl([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '<ide_opened_file>...</ide_opened_file>' },
            { type: 'text', text: WARMUP_PROMPT },
          ],
        },
      },
    ])
    expect(await isWarmupTranscript(file)).toBe(false)
  })

  test('文件不存在 / 内容损坏 → false（宁可漏掉残留，也不能误删会话）', async () => {
    expect(await isWarmupTranscript(join(tmpdir(), 'does-not-exist-xyz.jsonl'))).toBe(false)

    const dir = mkdtempSync(join(tmpdir(), 'warmup-broken-'))
    tempDirs.push(dir)
    const broken = join(dir, 'broken.jsonl')
    writeFileSync(broken, '{ not json\n{"type":"user"\n', 'utf-8')
    expect(await isWarmupTranscript(broken)).toBe(false)
  })

  test('空文件 → false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warmup-empty-'))
    tempDirs.push(dir)
    const empty = join(dir, 'empty.jsonl')
    writeFileSync(empty, '', 'utf-8')
    expect(await isWarmupTranscript(empty)).toBe(false)
  })
})

describe('扫描与清理对预热残留的处理', () => {
  /** 造一个 fake HOME：同一项目下 1 条真实会话 + 1 份预热残留 */
  function setupHome(): { cwd: string } {
    const fakeHome = mkdtempSync(join(tmpdir(), 'claude-warmup-home-'))
    tempDirs.push(fakeHome)
    process.env.HOME = fakeHome

    const cwd = '/test/proj'
    const projectDir = join(fakeHome, '.claude', 'projects', encodeCwdToProjectDir(cwd))
    mkdirSync(projectDir, { recursive: true })

    writeFileSync(
      join(projectDir, 'real-session.jsonl'),
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: '真实提问' } }),
        JSON.stringify({ type: 'ai-title', aiTitle: '真实会话' }),
      ].join('\n') + '\n',
      'utf-8',
    )
    writeFileSync(
      join(projectDir, 'warmup-leftover.jsonl'),
      WARMUP_LINES.map((l) => JSON.stringify(l)).join('\n') + '\n',
      'utf-8',
    )
    return { cwd }
  }

  test('listClaudeSessionsFromDisk 跳过预热残留', async () => {
    const { cwd } = setupHome()
    const sessions = await listClaudeSessionsFromDisk(cwd)
    expect(sessions.map((s) => s.backendThreadId)).toEqual(['real-session'])
  })

  test('listWarmupTranscripts 只收集预热残留——跟扫描正好互补', async () => {
    const { cwd } = setupHome()
    const found = await listWarmupTranscripts(cwd)
    expect(found.map((f) => f.sessionId)).toEqual(['warmup-leftover'])
    expect(found[0]?.filePath).toContain('warmup-leftover.jsonl')
  })

  test('全盘扫描（不传 cwd）同样跳过', async () => {
    setupHome()
    const sessions = await listClaudeSessionsFromDisk()
    expect(sessions.map((s) => s.backendThreadId)).toEqual(['real-session'])
    expect((await listWarmupTranscripts()).map((f) => f.sessionId)).toEqual(['warmup-leftover'])
  })
})
