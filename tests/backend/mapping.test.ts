import {
  assessRisk,
  codexApprovalToRequest,
  codexCommandToOutput,
  codexFileChangeToOutput,
  codexItemToActivityBlock,
  codexItemToContentBlock,
  codexItemToToolCallInfo,
  diffStats,
} from '@main/backend/codex/mapping'
import { describe, expect, test } from 'vitest'

describe('assessRisk', () => {
  test('只读命令 = low', () => {
    expect(assessRisk('shell_command', 'git status')).toBe('low')
    expect(assessRisk('shell_command', 'ls -la')).toBe('low')
    expect(assessRisk('shell_command', 'cat README.md')).toBe('low')
    expect(assessRisk('shell_command', 'rg "foo"')).toBe('low')
  })

  test('危险命令 = high', () => {
    expect(assessRisk('shell_command', 'rm file.txt')).toBe('high')
    expect(assessRisk('shell_command', 'git push --force origin main')).toBe('high')
    expect(assessRisk('shell_command', 'npm publish')).toBe('high')
    expect(assessRisk('shell_command', 'sudo apt install')).toBe('high')
  })

  test('普通命令 = medium', () => {
    expect(assessRisk('shell_command', 'echo hello')).toBe('low') // echo 在白名单
    expect(assessRisk('shell_command', 'node script.js')).toBe('medium')
    expect(assessRisk('shell_command', 'pnpm test')).toBe('medium')
  })

  test('file_edit 默认 medium', () => {
    expect(assessRisk('file_edit', '/some/path')).toBe('medium')
  })

  test('mcp 默认 medium', () => {
    expect(assessRisk('mcp', 'some-mcp-tool')).toBe('medium')
  })
})

describe('codexItemToToolCallInfo', () => {
  test('command_execution → shell_command tool', () => {
    const info = codexItemToToolCallInfo({
      type: 'command_execution',
      id: 'cmd_1',
      command: 'git status',
      cwd: '/tmp',
      status: 'in_progress',
    })
    expect(info).toEqual({
      kind: 'shell_command',
      title: 'git status',
      detail: 'git status',
    })
  })

  test('长命令被截断到 80 字符', () => {
    const longCmd = 'x'.repeat(200)
    const info = codexItemToToolCallInfo({
      type: 'command_execution',
      id: 'cmd_1',
      command: longCmd,
      status: 'in_progress',
    })
    expect(info!.title.length).toBe(80)
  })

  test('file_change → file_edit tool', () => {
    const info = codexItemToToolCallInfo({
      type: 'file_change',
      id: 'fc_1',
      changes: [
        { path: '/a.ts', kind: 'edit', diff: '@@ -1 +1 @@' },
        { path: '/b.ts', kind: 'edit' },
      ],
      status: 'in_progress',
    })
    expect(info!.kind).toBe('file_edit')
    expect(info!.title).toContain('/a.ts')
    expect(info!.title).toContain('/b.ts')
  })

  test('agent_message 返回 null（不是 tool call）', () => {
    const info = codexItemToToolCallInfo({
      type: 'agent_message',
      id: 'msg_1',
      text: 'hello',
    })
    expect(info).toBeNull()
  })

  test('agentMessage 保留 commentary/final_answer phase', () => {
    expect(
      codexItemToContentBlock({
        type: 'agentMessage',
        id: 'msg_1',
        text: '先检查一下',
        phase: 'commentary',
      }),
    ).toEqual({
      id: 'msg_1-text',
      type: 'text',
      text: '先检查一下',
      phase: 'commentary',
    })
  })

  test('未知 item 类型返回 null', () => {
    const info = codexItemToToolCallInfo({
      type: 'unknown_future_type',
      id: 'x_1',
    })
    expect(info).toBeNull()
  })
})

describe('codexItemToActivityBlock', () => {
  test('使用 commandActions 区分读取、搜索与普通命令', () => {
    const block = codexItemToActivityBlock({
      type: 'commandExecution',
      id: 'cmd_1',
      command: 'sed -n 1,20p a.ts; rg foo src; pnpm test',
      cwd: '/repo',
      status: 'completed',
      commandActions: [
        { type: 'read', command: 'sed -n 1,20p a.ts', name: 'a.ts', path: '/repo/a.ts' },
        { type: 'search', command: 'rg foo src', query: 'foo', path: '/repo/src' },
        { type: 'unknown', command: 'pnpm test' },
      ],
      aggregatedOutput: null,
      exitCode: 0,
      durationMs: 1200,
    })

    expect(block?.activities.map((activity) => activity.kind)).toEqual([
      'file_read',
      'search',
      'command',
    ])
    expect(block?.status).toBe('completed')
  })

  test('统计 unified diff 墆删行', () => {
    expect(diffStats('--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+next')).toEqual({
      additions: 2,
      deletions: 1,
    })
  })

  // V4 Patch: 现代 codex 用 apply_patch（custom_tool_call item）改文件，
  // mapping 应把它转成 file_change 活动，每文件 diff 是 V4 子段。
  test('custom_tool_call(apply_patch) → file_change 活动，V4 patch 切分成单文件', () => {
    const block = codexItemToActivityBlock({
      type: 'custom_tool_call',
      id: 'ctc_1',
      call_id: 'call_1',
      name: 'apply_patch',
      status: 'completed',
      input: [
        '*** Begin Patch',
        '*** Add File: src/new.ts',
        '+import foo',
        '*** Update File: src/main.ts',
        '@@',
        ' ctx',
        '-old',
        '+new',
        '*** End Patch',
      ].join('\n'),
    })
    expect(block?.activities).toHaveLength(1)
    const activity = block?.activities[0]
    expect(activity?.kind).toBe('file_change')
    const changes = activity?.kind === 'file_change' ? activity.changes : []
    expect(changes.map((c) => c.path)).toEqual(['src/new.ts', 'src/main.ts'])
    expect(changes.map((c) => c.kind)).toEqual(['add', 'update'])
    // Update 文件的 stats 按 V4 +/- 行算
    expect(changes[1]?.stats).toEqual({ additions: 1, deletions: 1 })
    // diff 是各文件的 V4 子段（含头行），渲染器 extractFileFromV4Patch 能再切
    expect(changes[1]?.diff).toContain('*** Update File: src/main.ts')
    expect(changes[1]?.diff).toContain('-old')
    expect(changes[1]?.diff).not.toContain('*** Add File')
  })

  test('custom_tool_call 非 apply_patch 不产生活动', () => {
    const block = codexItemToActivityBlock({
      type: 'custom_tool_call',
      id: 'ctc_2',
      name: 'exec',
      input: 'ls',
      status: 'completed',
    })
    expect(block).toBeNull()
  })
})

describe('codexCommandToOutput', () => {
  test('成功 exit 0', () => {
    const out = codexCommandToOutput({
      type: 'command_execution',
      id: 'cmd_1',
      command: 'ls',
      status: 'completed',
      exitCode: 0,
      aggregatedOutput: 'file1\nfile2',
      durationMs: 100,
    })
    expect(out.ok).toBe(true)
    expect(out.summary).toContain('exit 0')
    expect(out.summary).toContain('100ms')
    expect(out.output).toBe('file1\nfile2')
  })

  test('失败 exit 非 0', () => {
    const out = codexCommandToOutput({
      type: 'command_execution',
      id: 'cmd_1',
      command: 'false',
      status: 'completed',
      exitCode: 1,
    })
    expect(out.ok).toBe(false)
    expect(out.summary).toBe('exit 1')
  })
})

describe('codexFileChangeToOutput', () => {
  test('成功', () => {
    const out = codexFileChangeToOutput({
      type: 'file_change',
      id: 'fc_1',
      changes: [{ path: '/a.ts', kind: 'edit', diff: '@@ ...' }],
      status: 'completed',
    })
    expect(out.ok).toBe(true)
    expect(out.summary).toContain('1 file')
  })
})

describe('codexApprovalToRequest', () => {
  test('shell_command approval', () => {
    const req = codexApprovalToRequest(
      'shell_command',
      'rm file.txt',
      '/tmp',
      'needs to cleanup',
      undefined,
    )
    expect(req.kind).toBe('shell_command')
    expect(req.title).toBe('rm file.txt')
    expect(req.detail).toContain('$ rm file.txt')
    expect(req.detail).toContain('cwd: /tmp')
    expect(req.riskLevel).toBe('high')
  })

  test('file_edit approval', () => {
    const req = codexApprovalToRequest('file_edit', undefined, undefined, undefined, [
      { path: '/a.ts', kind: 'edit', diff: '@@ ...' },
    ])
    expect(req.kind).toBe('file_edit')
    expect(req.title).toContain('1 file')
    expect(req.detail).toContain('/a.ts')
    expect(req.riskLevel).toBe('medium')
  })
})
