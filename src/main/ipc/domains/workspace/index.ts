import type { WorkspaceHandlers } from '@shared/ipc/workspace'

import { handleRendererRequest } from '../../typed'

import {
  addWorkspace,
  listWorkspaces,
  removeWorkspace,
  renameWorkspace,
  setWorkspaceEditor,
} from './handlers'

export function registerWorkspaceHandlers(): void {
  handleRendererRequest<WorkspaceHandlers, 'workspace.list'>('workspace.list', listWorkspaces)
  handleRendererRequest<WorkspaceHandlers, 'workspace.add'>('workspace.add', addWorkspace)
  handleRendererRequest<WorkspaceHandlers, 'workspace.remove'>('workspace.remove', removeWorkspace)
  handleRendererRequest<WorkspaceHandlers, 'workspace.rename'>('workspace.rename', renameWorkspace)
  handleRendererRequest<WorkspaceHandlers, 'workspace.setEditor'>(
    'workspace.setEditor',
    setWorkspaceEditor,
  )
}

export type { WorkspaceHandlers } from '@shared/ipc/workspace'
