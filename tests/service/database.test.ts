import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DatabaseService } from '@main/service/database'
import type { WorkspaceRecord } from '@shared/domain'
import { describe, expect, test, beforeEach, afterEach } from 'vitest'

let db: DatabaseService
let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'catmax-test-'))
  db = new DatabaseService(join(tempDir, 'test.db'))
  db.migrate()
})

afterEach(() => {
  db.close()
  rmSync(tempDir, { recursive: true, force: true })
})

function makeWorkspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: 'test-id',
    path: '/tmp/test-workspace',
    name: 'test-workspace',
    preferredEditor: null,
    lastOpenedAt: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('DatabaseService', () => {
  test('migrate 创建表（重复执行不报错）', () => {
    expect(() => db.migrate()).not.toThrow()
  })

  test('insertWorkspace + findWorkspaceById', () => {
    const ws = makeWorkspace({ id: 'ws-1', path: '/a/b' })
    db.insertWorkspace(ws)
    const found = db.findWorkspaceById('ws-1')
    expect(found).toEqual(ws)
  })

  test('findWorkspaceByPath', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1', path: '/a/b' }))
    expect(db.findWorkspaceByPath('/a/b')?.id).toBe('ws-1')
    expect(db.findWorkspaceByPath('/not/exist')).toBeNull()
  })

  test('listWorkspaces 按 lastOpenedAt 倒序', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1', path: '/a', lastOpenedAt: 1000 }))
    db.insertWorkspace(makeWorkspace({ id: 'ws-2', path: '/b', lastOpenedAt: 3000 }))
    db.insertWorkspace(makeWorkspace({ id: 'ws-3', path: '/c', lastOpenedAt: 2000 }))

    const list = db.listWorkspaces()
    expect(list.map((w) => w.id)).toEqual(['ws-2', 'ws-3', 'ws-1'])
  })

  test('path 唯一约束（重复插入抛错）', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1', path: '/dup' }))
    expect(() => db.insertWorkspace(makeWorkspace({ id: 'ws-2', path: '/dup' }))).toThrow()
  })

  test('updateWorkspaceName', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1' }))
    db.updateWorkspaceName('ws-1', '新名字')
    expect(db.findWorkspaceById('ws-1')?.name).toBe('新名字')
  })

  test('updateWorkspaceEditor', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1' }))
    db.updateWorkspaceEditor('ws-1', 'vscode')
    expect(db.findWorkspaceById('ws-1')?.preferredEditor).toBe('vscode')
  })

  test('deleteWorkspace', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1' }))
    db.deleteWorkspace('ws-1')
    expect(db.findWorkspaceById('ws-1')).toBeNull()
  })

  test('app_state setState/getState', () => {
    db.setState('foo', 'bar')
    expect(db.getState('foo')).toBe('bar')
    db.setState('foo', 'baz') // upsert
    expect(db.getState('foo')).toBe('baz')
  })

  test('app_state deleteState', () => {
    db.setState('foo', 'bar')
    db.deleteState('foo')
    expect(db.getState('foo')).toBeNull()
  })
})
