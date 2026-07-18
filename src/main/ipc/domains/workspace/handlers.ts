import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'

import { ctx } from '@main/context'
import { logger } from '@main/service/logger'
import type { WorkspaceRecord } from '@shared/domain'
import type {
  AddWorkspaceArgs,
  RenameWorkspaceArgs,
  SetWorkspaceEditorArgs,
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
  const path = args.path.trim()
  if (!path) throw new WorkspaceError('invalid-path', 'path is empty')

  if (!existsSync(path)) {
    throw new WorkspaceError('invalid-path', `path does not exist: ${path}`)
  }
  const stat = statSync(path)
  if (!stat.isDirectory()) {
    throw new WorkspaceError('invalid-path', `path is not a directory: ${path}`)
  }

  const existing = ctx.db.findWorkspaceByPath(path)
  if (existing) {
    throw new WorkspaceError('already-exists', `workspace already added: ${path}`)
  }

  const now = Date.now()
  const record: WorkspaceRecord = {
    id: randomUUID(),
    path,
    name: args.name?.trim() || basename(path),
    preferredEditor: null,
    lastOpenedAt: now,
    createdAt: now,
  }
  ctx.db.insertWorkspace(record)
  log.info('added', record.id, record.path)
  return record
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

export const setWorkspaceEditor = async (args: SetWorkspaceEditorArgs): Promise<void> => {
  const existing = ctx.db.findWorkspaceById(args.id)
  if (!existing) throw new WorkspaceError('not-found', `workspace not found: ${args.id}`)
  ctx.db.updateWorkspaceEditor(args.id, args.editor)
}
