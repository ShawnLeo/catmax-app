import type { WorkspaceFolderContext } from '@shared/backend/types'

/** Electron IPC cannot structured-clone Vue reactive proxies, including nested array entries. */
export function toPlainWorkspaceFolders(
  folders: readonly WorkspaceFolderContext[],
): WorkspaceFolderContext[]
export function toPlainWorkspaceFolders(folders: undefined): undefined
export function toPlainWorkspaceFolders(
  folders?: readonly WorkspaceFolderContext[],
): WorkspaceFolderContext[] | undefined {
  return folders?.map((folder) => ({
    id: folder.id,
    path: folder.path,
    alias: folder.alias,
    role: folder.role,
  }))
}
