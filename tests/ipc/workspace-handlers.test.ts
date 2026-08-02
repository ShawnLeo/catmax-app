import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
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
const {
  addWorkspace,
  listWorkspaces,
  removeWorkspace,
  renameWorkspace,
  setWorkspaceEditor,
  touchWorkspace,
} = await import('@main/ipc/domains/workspace/handlers')

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
  test('addWorkspace 保存一个主文件夹和多个次文件夹', async () => {
    const primary = mkdtempSync(join(tmpdir(), 'catmax-ws-primary-'))
    const secondaryA = mkdtempSync(join(tmpdir(), 'catmax-ws-secondary-a-'))
    const secondaryB = mkdtempSync(join(tmpdir(), 'catmax-ws-secondary-b-'))
    try {
      const ws = await addWorkspace({
        path: primary,
        name: 'multi-root',
        secondaryPaths: [secondaryA, secondaryB],
      })
      expect(ws.folders).toHaveLength(3)
      expect(ws.folders[0]).toMatchObject({ role: 'primary', sortOrder: 0 })
      expect(ws.folders.slice(1).every((folder) => folder.role === 'secondary')).toBe(true)
      expect((await listWorkspaces()).find((item) => item.id === ws.id)?.folders).toHaveLength(3)
    } finally {
      rmSync(primary, { recursive: true, force: true })
      rmSync(secondaryA, { recursive: true, force: true })
      rmSync(secondaryB, { recursive: true, force: true })
    }
  })

  test('addWorkspace 拒绝主文件夹内部的冗余次文件夹', async () => {
    const primary = mkdtempSync(join(tmpdir(), 'catmax-ws-nested-'))
    const nested = join(primary, 'packages', 'ui')
    mkdirSync(nested, { recursive: true })
    try {
      await expect(addWorkspace({ path: primary, secondaryPaths: [nested] })).rejects.toMatchObject(
        {
          code: 'invalid-path',
        },
      )
    } finally {
      rmSync(primary, { recursive: true, force: true })
    }
  })

  test('addWorkspace 创建合法目录的 workspace', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'catmax-ws-add-'))
    try {
      const ws = await addWorkspace({ path: tempDir })
      expect(ws.id).toBeTruthy()
      expect(ws.path).toBe(realpathSync.native(tempDir))
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

  test('touchWorkspace 更新 lastOpenedAt 并排到最前', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'catmax-ws-touch-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'catmax-ws-touch-b-'))
    try {
      const wsA = await addWorkspace({ path: dirA })
      const wsB = await addWorkspace({ path: dirB })
      // 创建顺序：A 先 B 后，初始列表 B 在前
      expect((await listWorkspaces())[0]?.id).toBe(wsB.id)

      // touch A —— A 应排到最前，且 lastOpenedAt 增大
      const beforeA = (await listWorkspaces()).find((w) => w.id === wsA.id)!.lastOpenedAt
      // 确保 touch 的时间戳严格大于创建时间（addWorkspace 用 Date.now()，这里稍等一拍）
      await new Promise((r) => setTimeout(r, 5))
      await touchWorkspace({ id: wsA.id })
      const list = await listWorkspaces()
      expect(list[0]?.id).toBe(wsA.id)
      expect(list.find((w) => w.id === wsA.id)!.lastOpenedAt).toBeGreaterThan(beforeA)
    } finally {
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })

  test('touchWorkspace 不存在的 id 抛 not-found', async () => {
    await expect(touchWorkspace({ id: 'non-existent-id' })).rejects.toMatchObject({
      code: 'not-found',
    })
  })
})
