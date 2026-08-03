/**
 * workspace domain IPC 契约。
 * 函数签名即契约——main 实现，renderer 通过 window.api 调用。
 *
 * 这些函数本体在 shared 里只声明签名（抛 Not Implemented），
 * 真实实现在 main/ipc/domains/workspace/handlers.ts。
 */
import type { EditorId } from '../constants'
import type { WorkspaceRecord } from '../domain'

export interface AddWorkspaceArgs {
  /** 主文件夹；保留 path 字段名以兼容现有 renderer 和历史调用。 */
  path: string
  name?: string
  secondaryPaths?: string[]
}

export interface RenameWorkspaceArgs {
  id: string
  name: string
}

export interface SetWorkspaceEditorArgs {
  id: string
  editor: EditorId
}

export interface UpdateWorkspaceFoldersArgs {
  id: string
  name: string
  /** 全量替换的次文件夹路径列表（主文件夹不可改，不在此参数内）。 */
  secondaryPaths: string[]
}

// 函数签名（契约）。body 不重要，类型才重要。
// stub 参数名以 `_` 前缀避免 unused 报错；参数类型从 typeof 派生不受影响。
export async function listWorkspaces(): Promise<WorkspaceRecord[]> {
  throw new Error('implemented in main')
}
export async function addWorkspace(_args: AddWorkspaceArgs): Promise<WorkspaceRecord> {
  throw new Error('implemented in main')
}
export async function removeWorkspace(_args: { id: string }): Promise<void> {
  throw new Error('implemented in main')
}
export async function renameWorkspace(_args: RenameWorkspaceArgs): Promise<void> {
  throw new Error('implemented in main')
}
export async function setWorkspaceEditor(_args: SetWorkspaceEditorArgs): Promise<void> {
  throw new Error('implemented in main')
}
export async function touchWorkspace(_args: { id: string }): Promise<void> {
  throw new Error('implemented in main')
}
export async function updateWorkspaceFolders(
  _args: UpdateWorkspaceFoldersArgs,
): Promise<WorkspaceRecord> {
  throw new Error('implemented in main')
}

/** 聚合类型：所有 workspace handler 的 channel → 签名映射 */
export type WorkspaceHandlers = {
  'workspace.list': typeof listWorkspaces
  'workspace.add': typeof addWorkspace
  'workspace.remove': typeof removeWorkspace
  'workspace.rename': typeof renameWorkspace
  'workspace.setEditor': typeof setWorkspaceEditor
  'workspace.touch': typeof touchWorkspace
  'workspace.updateFolders': typeof updateWorkspaceFolders
}
