import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, relative } from 'node:path'

import { ctx } from '@main/context'
import { logger } from '@main/service/logger'
import type { WorkspaceFolderRecord, WorkspaceRecord } from '@shared/domain'
import type {
  AddWorkspaceArgs,
  RenameWorkspaceArgs,
  SetWorkspaceEditorArgs,
  UpdateWorkspaceFoldersArgs,
} from '@shared/ipc/workspace'

const log = logger.domain('workspace-handler')

export class WorkspaceError extends Error {
  constructor(
    public code: 'not-found' | 'invalid-path' | 'already-exists',
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

export const listWorkspaces = async (): Promise<WorkspaceRecord[]> => {
  return ctx.db.listWorkspaces()
}

export const addWorkspace = async (args: AddWorkspaceArgs): Promise<WorkspaceRecord> => {
  const path = normalizeDirectory(args.path)

  const existing = ctx.db.findWorkspaceByPath(path)
  if (existing) {
    throw new WorkspaceError('already-exists', `workspace already added: ${path}`)
  }

  const now = Date.now()
  const workspaceId = randomUUID()
  const workspaceName = args.name?.trim() || basename(path)
  const folders = buildWorkspaceFolders(
    workspaceId,
    path,
    (args.secondaryPaths ?? []).map(normalizeDirectory),
    now,
  )
  const record: WorkspaceRecord = {
    id: workspaceId,
    path,
    name: workspaceName,
    folders,
    preferredEditor: null,
    lastOpenedAt: now,
    createdAt: now,
  }
  ctx.db.insertWorkspace(record)
  log.info('added', record.id, record.path)
  return record
}

function normalizeDirectory(rawPath: string): string {
  const candidate = rawPath.trim()
  if (!candidate) throw new WorkspaceError('invalid-path', 'path is empty')
  if (!existsSync(candidate)) {
    throw new WorkspaceError('invalid-path', `path does not exist: ${candidate}`)
  }
  if (!statSync(candidate).isDirectory()) {
    throw new WorkspaceError('invalid-path', `path is not a directory: ${candidate}`)
  }
  return realpathSync.native(candidate)
}

function buildWorkspaceFolders(
  workspaceId: string,
  primaryPath: string,
  secondaryPaths: string[],
  createdAt: number,
): WorkspaceFolderRecord[] {
  const uniquePaths = new Set([primaryPath])
  const aliases = new Set<string>()
  const folders: WorkspaceFolderRecord[] = []

  const add = (path: string, role: WorkspaceFolderRecord['role'], sortOrder: number): void => {
    if (uniquePaths.has(path) && role === 'secondary') {
      throw new WorkspaceError('invalid-path', `folder already added: ${path}`)
    }
    if (
      role === 'secondary' &&
      (isNestedPath(primaryPath, path) || isNestedPath(path, primaryPath))
    ) {
      throw new WorkspaceError(
        'invalid-path',
        `workspace folders cannot contain each other: ${path}`,
      )
    }
    uniquePaths.add(path)
    const alias = uniqueAlias(basename(path) || 'folder', aliases)
    aliases.add(alias)
    folders.push({
      id: randomUUID(),
      workspaceId,
      path,
      alias,
      role,
      sortOrder,
      createdAt,
    })
  }

  add(primaryPath, 'primary', 0)
  secondaryPaths.forEach((path, index) => add(path, 'secondary', index + 1))
  return folders
}

/**
 * 编辑场景专用：仅生成次文件夹记录，主文件夹保持不变。
 * 复用与 buildWorkspaceFolders 相同的去重 / 嵌套 / alias 唯一性校验，
 * 保证编辑后的次文件夹数据形态与创建时一致。
 */
function buildSecondaryWorkspaceFolders(
  workspaceId: string,
  primaryPath: string,
  secondaryPaths: string[],
  createdAt: number,
): WorkspaceFolderRecord[] {
  const uniquePaths = new Set([primaryPath])
  const aliases = new Set<string>()
  const folders: WorkspaceFolderRecord[] = []
  secondaryPaths.forEach((path, index) => {
    if (uniquePaths.has(path)) {
      throw new WorkspaceError('invalid-path', `folder already added: ${path}`)
    }
    if (isNestedPath(primaryPath, path) || isNestedPath(path, primaryPath)) {
      throw new WorkspaceError(
        'invalid-path',
        `workspace folders cannot contain each other: ${path}`,
      )
    }
    uniquePaths.add(path)
    const alias = uniqueAlias(basename(path) || 'folder', aliases)
    aliases.add(alias)
    folders.push({
      id: randomUUID(),
      workspaceId,
      path,
      alias,
      role: 'secondary',
      sortOrder: index + 1,
      createdAt,
    })
  })
  return folders
}

function isNestedPath(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path !== '' && !path.startsWith('..') && path !== '..'
}

function uniqueAlias(base: string, used: Set<string>): string {
  if (!used.has(base)) return base
  let suffix = 2
  while (used.has(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}

export const removeWorkspace = async (args: { id: string }): Promise<void> => {
  const existing = ctx.db.findWorkspaceById(args.id)
  if (!existing) throw new WorkspaceError('not-found', `workspace not found: ${args.id}`)
  ctx.db.deleteWorkspace(args.id)
  log.info('removed', args.id)
}

export const renameWorkspace = async (args: RenameWorkspaceArgs): Promise<void> => {
  const existing = ctx.db.findWorkspaceById(args.id)
  if (!existing) throw new WorkspaceError('not-found', `workspace not found: ${args.id}`)
  const name = args.name.trim()
  if (!name) throw new WorkspaceError('invalid-path', 'name cannot be empty')
  ctx.db.updateWorkspaceName(args.id, name)
}

/**
 * 编辑工作区：更新名称 + 全量替换次文件夹（主文件夹锁定，不可改）。
 * 返回更新后的完整 record，store 据此整体替换缓存项。
 */
export const updateWorkspaceFolders = async (
  args: UpdateWorkspaceFoldersArgs,
): Promise<WorkspaceRecord> => {
  const existing = ctx.db.findWorkspaceById(args.id)
  if (!existing) throw new WorkspaceError('not-found', `workspace not found: ${args.id}`)
  const name = args.name.trim()
  if (!name) throw new WorkspaceError('invalid-path', 'name cannot be empty')

  const primaryPath = existing.path
  const secondaryPaths = (args.secondaryPaths ?? []).map(normalizeDirectory)
  const now = Date.now()
  const secondaryFolders = buildSecondaryWorkspaceFolders(args.id, primaryPath, secondaryPaths, now)

  const updated = ctx.db.updateWorkspaceFolders(args.id, name, secondaryFolders)
  if (!updated) throw new WorkspaceError('not-found', `workspace not found: ${args.id}`)
  log.info('updated folders', updated.id, `${secondaryFolders.length} secondary`)
  return updated
}

export const setWorkspaceEditor = async (args: SetWorkspaceEditorArgs): Promise<void> => {
  const existing = ctx.db.findWorkspaceById(args.id)
  if (!existing) throw new WorkspaceError('not-found', `workspace not found: ${args.id}`)
  ctx.db.updateWorkspaceEditor(args.id, args.editor)
}

// 更新 last_opened_at —— 让"最近工作区"列表真正反映打开顺序。
export const touchWorkspace = async (args: { id: string }): Promise<void> => {
  const existing = ctx.db.findWorkspaceById(args.id)
  if (!existing) throw new WorkspaceError('not-found', `workspace not found: ${args.id}`)
  ctx.db.touchWorkspace(args.id, Date.now())
}
