import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test, afterEach, vi } from 'vitest'

// 用真实 DatabaseService（在 tempDir 上）mock context，避免污染
vi.mock('@main/context', async () => {
  const { DatabaseService } = await import('@main/service/database')
  const { mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const tempDir = mkdtempSync(join(tmpdir(), 'catmax-ws-ipc-'))
  const db = new DatabaseService(join(tempDir, 'test.db'))
  db.migrate()
  return {
    ctx: { db },
    __testTempDir: tempDir,
  }
})

const ctxModule: any = await import('@main/context')
const { addWorkspace, listWorkspaces, removeWorkspace, renameWorkspace, setWorkspaceEditor } =
  await import('@main/ipc/domains/workspace/handlers')

afterEach(() => {
  // 清空 db 数据避免污染（保留表结构）
  const tempDir = ctxModule.__testTempDir
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

describe('workspace handlers', () => {
  test('addWorkspace 创建合法目录的 workspace', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'catmax-ws-add-'))
    try {
      const ws = await addWorkspace({ path: tempDir })
      expect(ws.id).toBeTruthy()
      expect(ws.path).toBe(tempDir)
      expect(ws.name).toBeTruthy()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('addWorkspace 用 basename 作为默认 name', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'catmax-ws-name-'))
    const subDir = join(parent, 'my-project')
    mkdirSync(subDir)
    try {
      const ws = await addWorkspace({ path: subDir })
      expect(ws.name).toBe('my-project')
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test('addWorkspace 不存在的路径抛 invalid-path', async () => {
    await expect(addWorkspace({ path: '/nonexistent/path/xyz' })).rejects.toMatchObject({
      code: 'invalid-path',
    })
  })

  test('addWorkspace 文件（非目录）抛 invalid-path', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'catmax-ws-file-'))
    const filePath = join(tempDir, 'file.txt')
    writeFileSync(filePath, 'x')
    try {
      await expect(addWorkspace({ path: filePath })).rejects.toMatchObject({
        code: 'invalid-path',
      })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('addWorkspace 重复路径抛 already-exists', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'catmax-ws-dup-'))
    try {
      await addWorkspace({ path: tempDir })
      await expect(addWorkspace({ path: tempDir })).rejects.toMatchObject({
        code: 'already-exists',
      })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('listWorkspaces 返回所有', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'catmax-ws-list-'))
    try {
      await addWorkspace({ path: tempDir, name: 'ws1' })
      const list = await listWorkspaces()
      expect(list.length).toBeGreaterThanOrEqual(1)
      expect(list.some((w) => w.name === 'ws1')).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('removeWorkspace', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'catmax-ws-rm-'))
    try {
      const ws = await addWorkspace({ path: tempDir })
      const beforeCount = (await listWorkspaces()).length
      await removeWorkspace({ id: ws.id })
      const afterCount = (await listWorkspaces()).length
      expect(afterCount).toBe(beforeCount - 1)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('removeWorkspace 不存在的 id 抛 not-found', async () => {
    await expect(removeWorkspace({ id: 'non-existent-id' })).rejects.toMatchObject({
      code: 'not-found',
    })
  })

  test('renameWorkspace', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'catmax-ws-rn-'))
    try {
      const ws = await addWorkspace({ path: tempDir })
      await renameWorkspace({ id: ws.id, name: '新名字' })
      const list = await listWorkspaces()
      const found = list.find((w) => w.id === ws.id)
      expect(found?.name).toBe('新名字')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('setWorkspaceEditor', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'catmax-ws-ed-'))
    try {
      const ws = await addWorkspace({ path: tempDir })
      await setWorkspaceEditor({ id: ws.id, editor: 'cursor' })
      const list = await listWorkspaces()
      const found = list.find((w) => w.id === ws.id)
      expect(found?.preferredEditor).toBe('cursor')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
