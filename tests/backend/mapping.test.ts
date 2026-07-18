import {
  assessRisk,
  codexApprovalToRequest,
  codexCommandToOutput,
  codexFileChangeToOutput,
  codexItemToToolCallInfo,
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

  test('未知 item 类型返回 null', () => {
    const info = codexItemToToolCallInfo({
      type: 'unknown_future_type',
      id: 'x_1',
    })
    expect(info).toBeNull()
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
