// @vitest-environment node
//
// The default happy-dom environment doesn't fully intercept `vi.mock('node:child_process')`
// for source modules that import it. Switching to the node environment makes the mock work
// for editor-launcher's `import { spawn } from 'node:child_process'`.
import type * as childProcessNs from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchInEditor, isEditorAvailable } from '@main/service/editor-launcher'
import type { EditorId } from '@shared/constants'
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'

// Use vi.hoisted so the mock fn is initialized before vi.mock's factory runs.
const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcessNs>()
  return {
    ...actual,
    spawn: mockSpawn,
  }
})

interface FakeChild {
  on(event: 'spawn' | 'error' | 'close', cb: (...args: unknown[]) => void): FakeChild
  unref(): void
  stdout: { on(event: 'data', cb: (chunk: Buffer) => void): void }
  handlers: Map<string, Array<(...args: unknown[]) => void>>
  emit(event: 'spawn' | 'error' | 'close', ...args: unknown[]): void
}

function makeFakeChild(): FakeChild {
  const handlers: Map<string, Array<(...args: unknown[]) => void>> = new Map()
  return {
    on(event, cb) {
      const list = handlers.get(event) ?? []
      list.push(cb)
      handlers.set(event, list)
      return this
    },
    unref() {
      // noop
    },
    stdout: {
      on() {
        // no-op for test
      },
    },
    handlers,
    emit(event, ...args) {
      for (const cb of handlers.get(event) ?? []) cb(...args)
    },
  }
}

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'catmax-editor-test-'))
  mockSpawn.mockReset()
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('editor-launcher', () => {
  test('文件不存在时返回 launched=false', async () => {
    const result = await launchInEditor('vscode', {
      workspacePath: tempDir,
      relativePath: 'nope.ts',
    })
    expect(result.launched).toBe(false)
    expect(result.error).toContain('does not exist')
  })

  test('vscode 命令格式是 file:line:column', async () => {
    writeFileSync(join(tempDir, 'a.ts'), 'a')

    mockSpawn.mockImplementation(() => {
      const child = makeFakeChild()
      setTimeout(() => child.emit('spawn'), 0)
      return child as unknown as ChildProcess
    })

    const result = await launchInEditor('vscode', {
      workspacePath: tempDir,
      relativePath: 'a.ts',
      line: 10,
      column: 5,
    })
    expect(result.editor).toBe('vscode')
    expect(result.launched).toBe(true)
    expect(mockSpawn).toHaveBeenCalled()
    const callArgs = mockSpawn.mock.calls[0]
    expect(callArgs?.[0]).toBe('code')
    expect(callArgs?.[1]).toEqual([expect.stringContaining('a.ts:10:5')])
  })

  test('intellij 用 line file 格式', async () => {
    writeFileSync(join(tempDir, 'a.ts'), 'a')
    mockSpawn.mockImplementation(() => {
      const child = makeFakeChild()
      setTimeout(() => child.emit('spawn'), 0)
      return child as unknown as ChildProcess
    })

    const result = await launchInEditor('intellij', {
      workspacePath: tempDir,
      relativePath: 'a.ts',
      line: 42,
    })
    expect(result.editor).toBe('intellij')
    expect(result.launched).toBe(true)
    const callArgs = mockSpawn.mock.calls[0]
    expect(callArgs?.[0]).toBe('idea')
    expect(callArgs?.[1]).toEqual(['42', expect.stringContaining('a.ts')])
  })

  test('ENOENT 错误返回 launched=false 含未找到信息', async () => {
    writeFileSync(join(tempDir, 'a.ts'), 'a')
    const errnoException: NodeJS.ErrnoException = new Error('not found') as NodeJS.ErrnoException
    errnoException.code = 'ENOENT'
    mockSpawn.mockImplementation(() => {
      const child = makeFakeChild()
      setTimeout(() => child.emit('error', errnoException), 0)
      return child as unknown as ChildProcess
    })

    const result = await launchInEditor('vscode', {
      workspacePath: tempDir,
      relativePath: 'a.ts',
    })
    expect(result.launched).toBe(false)
    expect(result.error).toContain('未找到')
  })

  test('isEditorAvailable 返回 boolean', async () => {
    mockSpawn.mockImplementation(() => {
      const child = makeFakeChild()
      setTimeout(() => child.emit('close', 1), 0)
      return child as unknown as ChildProcess
    })
    const result = await isEditorAvailable('vscode')
    expect(typeof result).toBe('boolean')
    expect(result).toBe(false)
  })

  test('编译时类型校验：EditorId 包含 5 个 IDE', () => {
    const editors: EditorId[] = ['vscode', 'cursor', 'intellij', 'webstorm', 'sublime']
    expect(editors.length).toBe(5)
  })
})
