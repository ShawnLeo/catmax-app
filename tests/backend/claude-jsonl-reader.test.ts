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

import {
  decodeProjectDirToCwd,
  encodeCwdToProjectDir,
  listClaudeSessionsFromDisk,
  readClaudeSessionJsonl,
  readHistoryFromJsonl,
  resolveSessionJsonlPath,
  resolveSubagentJsonlPath,
} from '@main/backend/claude/jsonl-reader'
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

describe('resolveSubagentJsonlPath', () => {
  test('子 Agent 目录挂在 session 目录下，靠 agentId 扫出来', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'h-'))
    tempDirs.push(fakeHome)
    process.env.HOME = fakeHome
    const subagentDir = join(
      fakeHome,
      '.claude',
      'projects',
      '-Users-x-demo',
      'sess-abc',
      'subagents',
    )
    mkdirSync(subagentDir, { recursive: true })
    const filePath = join(subagentDir, 'agent-a1b2.jsonl')
    writeFileSync(filePath, '', 'utf-8')

    expect(resolveSubagentJsonlPath('a1b2', '/Users/x/demo')).toBe(filePath)
  })

  test('项目目录不存在时退回老布局，不抛', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'h-'))
    tempDirs.push(fakeHome)
    process.env.HOME = fakeHome
    expect(resolveSubagentJsonlPath('a1b2', '/Users/x/demo')).toBe(
      join(fakeHome, '.claude', 'projects', '-Users-x-demo', 'subagents', 'agent-a1b2.jsonl'),
    )
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

describe('decodeProjectDirToCwd', () => {
  test('encodeCwdToProjectDir 的逆运算（路径不含 - 时无歧义）', () => {
    expect(decodeProjectDirToCwd('-Users-shawn-foo')).toBe('/Users/shawn/foo')
    expect(decodeProjectDirToCwd('-tmp')).toBe('/tmp')
  })
})

describe('listClaudeSessionsFromDisk', () => {
  /** 造一个 fake HOME 含多个项目目录 + jsonl，返回 fakeHome 路径 */
  function setupFakeProjectsHome(): string {
    const fakeHome = mkdtempSync(join(tmpdir(), 'claude-scan-'))
    tempDirs.push(fakeHome)
    process.env.HOME = fakeHome

    const projectsRoot = join(fakeHome, '.claude', 'projects')
    mkdirSync(projectsRoot, { recursive: true })

    // 项目 1：/test/proj-a，2 个 session（其中一个有 ai-title）
    const projA = join(projectsRoot, '-test-proj-a')
    mkdirSync(projA, { recursive: true })
    writeFileSync(
      join(projA, 'sess-a1.jsonl'),
      [
        JSON.stringify({ type: 'ai-title', aiTitle: 'Project A Session 1' }),
        JSON.stringify({
          type: 'assistant',
          message: { id: 'm1', role: 'assistant', model: 'claude-sonnet', content: [] },
        }),
      ].join('\n') + '\n',
      'utf-8',
    )
    writeFileSync(
      join(projA, 'sess-a2.jsonl'),
      [JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })].join('\n') +
        '\n',
      'utf-8',
    )

    // 项目 2：/test/proj-b，1 个 session，没有 ai-title
    const projB = join(projectsRoot, '-test-proj-b')
    mkdirSync(projB, { recursive: true })
    writeFileSync(
      join(projB, 'sess-b1.jsonl'),
      [JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } })].join('\n') +
        '\n',
      'utf-8',
    )

    // 非 .jsonl 文件——应该被跳过
    writeFileSync(join(projA, 'README.txt'), 'ignore me', 'utf-8')
    // 隐藏文件——应该被跳过
    writeFileSync(join(projA, '.hidden.jsonl'), '{}', 'utf-8')
    // 损坏 jsonl——应能扫到（stat 成功），但 title 为 null
    writeFileSync(join(projA, 'sess-broken.jsonl'), '{not valid json\n', 'utf-8')

    return fakeHome
  }

  test('不传 cwd：扫所有项目目录的所有 .jsonl', async () => {
    setupFakeProjectsHome()
    const result = await listClaudeSessionsFromDisk()
    // a1 + a2 + broken + b1 = 4 个有效 jsonl
    expect(result.length).toBe(4)
    const ids = result.map((r) => r.backendThreadId).sort()
    expect(ids).toEqual(['sess-a1', 'sess-a2', 'sess-b1', 'sess-broken'])
  })

  test('从 jsonl 流式读 aiTitle，没有 ai-title 行时退回首条用户消息', async () => {
    setupFakeProjectsHome()
    const result = await listClaudeSessionsFromDisk()
    const a1 = result.find((r) => r.backendThreadId === 'sess-a1')
    const a2 = result.find((r) => r.backendThreadId === 'sess-a2')
    expect(a1?.title).toBe('Project A Session 1')
    // Session Title Fallback: 没有 ai-title 行（SDK 跑出来的会话就是这样）
    expect(a2?.title).toBe('hi')
  })

  test('连用户消息都没有时 title 仍为 null', async () => {
    setupFakeProjectsHome()
    const result = await listClaudeSessionsFromDisk()
    const broken = result.find((r) => r.backendThreadId === 'sess-broken')
    expect(broken?.title).toBeNull()
  })

  test('从 jsonl 读 model', async () => {
    setupFakeProjectsHome()
    const result = await listClaudeSessionsFromDisk()
    const a1 = result.find((r) => r.backendThreadId === 'sess-a1')
    expect(a1?.model).toBe('claude-sonnet')
  })

  test('cwd 字段是反推出来的（可能歧义，但格式正确）', async () => {
    setupFakeProjectsHome()
    const result = await listClaudeSessionsFromDisk()
    const a1 = result.find((r) => r.backendThreadId === 'sess-a1')
    expect(a1?.cwd).toBe('/test/proj/a') // 注意歧义：原本是 /test/proj-a
  })

  test('sizeBytes 是文件大小', async () => {
    setupFakeProjectsHome()
    const result = await listClaudeSessionsFromDisk()
    for (const r of result) {
      expect(r.sizeBytes).toBeGreaterThan(0)
    }
  })

  test('lastActiveAt 是文件 mtime（毫秒）', async () => {
    setupFakeProjectsHome()
    const result = await listClaudeSessionsFromDisk()
    for (const r of result) {
      expect(r.lastActiveAt).toBeGreaterThan(0)
      // 是毫秒级时间戳（应该接近现在）
      expect(Date.now() - r.lastActiveAt).toBeLessThan(60_000)
    }
  })

  test('传 cwd：只扫单个项目目录', async () => {
    setupFakeProjectsHome()
    const result = await listClaudeSessionsFromDisk('/test/proj-a')
    expect(result.length).toBe(3) // a1 + a2 + broken
    expect(result.every((r) => r.cwd === '/test/proj-a')).toBe(true) // cwd 无歧义
  })

  test('projects 目录不存在时返回空数组', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'empty-home-'))
    tempDirs.push(fakeHome)
    process.env.HOME = fakeHome
    // 不创建 .claude/projects 目录
    const result = await listClaudeSessionsFromDisk()
    expect(result).toEqual([])
  })

  test('跳过隐藏目录（. 开头）', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'hidden-dir-'))
    tempDirs.push(fakeHome)
    process.env.HOME = fakeHome
    const projectsRoot = join(fakeHome, '.claude', 'projects')
    mkdirSync(join(projectsRoot, '.cache'), { recursive: true }) // 隐藏目录
    mkdirSync(join(projectsRoot, '-real-proj'), { recursive: true })
    writeFileSync(
      join(projectsRoot, '-real-proj', 'x.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } }) + '\n',
      'utf-8',
    )

    const result = await listClaudeSessionsFromDisk()
    expect(result.length).toBe(1) // 只有 -real-proj 下的，.cache 被跳过
    expect(result[0]?.backendThreadId).toBe('x')
  })

  test('ai-title 不在文件头部时（>4KB）仍能扫到——回归测', async () => {
    // 之前 readFileSync + 截断 4KB 的实现会漏掉这种——实测 76/90 的真实会话
    // ai-title 偏移中位 26KB，4KB 截断丢了 99%。改成流式扫后才能拿到。
    const fakeHome = mkdtempSync(join(tmpdir(), 'late-title-'))
    tempDirs.push(fakeHome)
    process.env.HOME = fakeHome
    const projectsRoot = join(fakeHome, '.claude', 'projects')
    const projDir = join(projectsRoot, '-test-late')
    mkdirSync(projDir, { recursive: true })

    // 先写一个巨大的 attachment（> 4KB）把 ai-title 挤到后面
    const bigAttachment = JSON.stringify({
      type: 'attachment',
      attachment: {
        type: 'file',
        filename: 'huge.json',
        content: { type: 'text', file: { filePath: 'huge.json', content: 'x'.repeat(20_000) } },
      },
    })
    const lines = [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
      bigAttachment,
      JSON.stringify({ type: 'ai-title', aiTitle: 'Late Title' }),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'm1', role: 'assistant', model: 'claude-sonnet', content: [] },
      }),
    ]
    writeFileSync(join(projDir, 'sess-late.jsonl'), lines.join('\n') + '\n', 'utf-8')

    const result = await listClaudeSessionsFromDisk()
    expect(result.length).toBe(1)
    expect(result[0]?.title).toBe('Late Title')
    expect(result[0]?.model).toBe('claude-sonnet')
  })
})

/**
 * Session Title Fallback: 只有 claude CLI 往 jsonl 写 `ai-title` 行，catmax 经 SDK
 * 跑出来的会话整个文件都没有那一行——侧边栏因此一片 "(新会话)"。这组测试锁住
 * "没有 ai-title 就用首条真实用户输入"的派生规则。
 */
describe('listClaudeSessionsFromDisk：首条用户消息派生标题', () => {
  /** 造一个只含指定行的单会话 fake HOME，返回扫描到的那条 */
  async function scanOne(lines: string[]) {
    const fakeHome = mkdtempSync(join(tmpdir(), 'derive-title-'))
    tempDirs.push(fakeHome)
    process.env.HOME = fakeHome
    const projDir = join(fakeHome, '.claude', 'projects', '-test-derive')
    mkdirSync(projDir, { recursive: true })
    writeFileSync(join(projDir, 'sess-x.jsonl'), lines.join('\n') + '\n', 'utf-8')
    const result = await listClaudeSessionsFromDisk('/test-derive')
    return result[0]
  }

  test('ai-title 优先于派生标题（哪怕它排在用户消息后面）', async () => {
    const entry = await scanOne([
      JSON.stringify({ type: 'user', message: { role: 'user', content: '第一句话' } }),
      JSON.stringify({ type: 'ai-title', aiTitle: '真正的标题' }),
    ])
    expect(entry?.title).toBe('真正的标题')
  })

  test('array 形态的 content 取第一个 text 块', async () => {
    const entry = await scanOne([
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '数组里的文本' }] },
      }),
    ])
    expect(entry?.title).toBe('数组里的文本')
  })

  test('slash command sentinel → 只取命令名', async () => {
    const entry = await scanOne([
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: '<command-message>init</command-message>\n<command-name>/init</command-name>',
        },
      }),
    ])
    expect(entry?.title).toBe('/init')
  })

  test('isMeta 的消息跳过——那是 claude 替用户展开的 prompt，不是用户输入', async () => {
    const entry = await scanOne([
      JSON.stringify({
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: 'Please analyze this codebase and create a CLAUDE.md' },
      }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '用户真正说的话' } }),
    ])
    expect(entry?.title).toBe('用户真正说的话')
  })

  test('tool_result 回填跳过，继续找真正的用户消息', async () => {
    const entry = await scanOne([
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: '一大坨工具输出' }],
        },
      }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '后面这句才是' } }),
    ])
    expect(entry?.title).toBe('后面这句才是')
  })

  test('claude 自动注入的信封跳过（caveat / stdout / 后台任务通知 / compact 摘要）', async () => {
    const entry = await scanOne([
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '<local-command-caveat>...</local-command-caveat>' },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: '<local-command-stdout>Compacted</local-command-stdout>',
        },
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '<task-notification><task-id>t1</task-id>' },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: 'This session is being continued from a previous conversation. Summary: ...',
        },
      }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '这条才算' } }),
    ])
    expect(entry?.title).toBe('这条才算')
  })

  test('剥掉 IDE 注入的 context tag 和 system-reminder，只留用户输入', async () => {
    const entry = await scanOne([
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content:
            '<ide_opened_file>The user opened the file /a/b.vue in the IDE. This may or may not be related to the current task.</ide_opened_file>\n' +
            '<system-reminder>忽略我</system-reminder>\n' +
            '帮我改一下这个组件',
        },
      }),
    ])
    expect(entry?.title).toBe('帮我改一下这个组件')
  })

  test('超长输入截断到 50 字符，换行压成空格', async () => {
    const entry = await scanOne([
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'a\nb\n' + 'x'.repeat(200) },
      }),
    ])
    expect(entry?.title).toBe(('a b ' + 'x'.repeat(200)).slice(0, 50))
    expect(entry?.title?.length).toBe(50)
  })

  test('剥完只剩空白 → 不产出标题', async () => {
    const entry = await scanOne([
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '<system-reminder>只有提醒</system-reminder>\n   ' },
      }),
    ])
    expect(entry?.title).toBeNull()
  })
})
