import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { ctx } from '@main/context'
import { launchInEditor } from '@main/service/editor-launcher'
import {
  readDirectory,
  readFilePreview,
  resolveFileReference,
  resolveWorkspaceEntry,
  searchWorkspace,
} from '@main/service/file-tree'
import { readImageThumbnail } from '@main/service/image-thumbnail'
import { DEFAULT_EDITOR } from '@shared/constants'
import type { WorkspaceFolderRecord, WorkspaceRecord } from '@shared/domain'
import type { DirEntry, FilePreview, MentionPreview, ResolvedFileReference } from '@shared/ipc/fs'

// File Tree IPC: renderer 只提交 workspaceId，主进程从数据库取得可信工作区根目录。
export const readDirectoryHandler = async (args: {
  workspaceId: string
  folderId?: string
  relativePath?: string
  respectGitignore?: boolean
}): Promise<DirEntry[]> => {
  const { folder } = requireWorkspaceFolder(args.workspaceId, args.folderId)
  return annotateEntries(
    await readDirectory(folder.path, args.relativePath ?? '', args.respectGitignore ?? true),
    folder,
  )
}

export const readFilePreviewHandler = async (args: {
  workspaceId: string
  folderId?: string
  relativePath: string
  absolutePath?: string
}): Promise<FilePreview> => {
  const { folder } = requireWorkspaceFolder(args.workspaceId, args.folderId)
  return readFilePreview(folder.path, args.relativePath, args.absolutePath)
}

export const searchFilesHandler = async (args: {
  workspaceId: string
  folderId?: string
  allFolders?: boolean
  query: string
  limit?: number
}): Promise<DirEntry[]> => {
  const workspace = requireWorkspace(args.workspaceId)
  if (args.allFolders) {
    const limit = args.limit ?? 200
    const perFolder = Math.max(limit, 30)
    const groups = await Promise.all(
      workspace.folders.map(async (folder) =>
        annotateEntries(await searchWorkspace(folder.path, args.query, perFolder), folder),
      ),
    )
    return groups.flat().slice(0, limit)
  }
  const { folder } = requireWorkspaceFolder(args.workspaceId, args.folderId)
  return annotateEntries(await searchWorkspace(folder.path, args.query, args.limit), folder)
}

export const resolveFileReferenceHandler = async (args: {
  workspaceId: string
  folderId?: string
  reference: string
  allowDirectory?: boolean
}): Promise<ResolvedFileReference | null> => {
  const workspace = requireWorkspace(args.workspaceId)
  const qualified = resolveQualifiedReference(workspace, args.reference)
  if (!qualified && args.folderId === undefined && isExternalReference(args.reference)) {
    for (const candidate of workspace.folders) {
      const resolved = await resolveFileReference(candidate.path, args.reference, {
        allowDirectory: args.allowDirectory === true,
      })
      if (resolved && resolved.absolutePath === undefined) {
        return {
          ...resolved,
          folderId: candidate.id,
          folderAlias: candidate.alias,
        }
      }
    }
  }
  const { folder } = requireWorkspaceFolder(args.workspaceId, qualified?.folder.id ?? args.folderId)
  const resolved = await resolveFileReference(folder.path, qualified?.reference ?? args.reference, {
    allowDirectory: args.allowDirectory === true,
  })
  return resolved ? { ...resolved, folderId: folder.id, folderAlias: folder.alias } : null
}

function isExternalReference(reference: string): boolean {
  const value = reference.trim().replace(/^file:\/\//, '')
  return isAbsolute(value) || value.startsWith('~/') || value.startsWith('$HOME/')
}

export const readMentionPreviewHandler = async (args: {
  workspaceId: string
  reference: string
  maxSize?: number
}): Promise<MentionPreview | null> => {
  const workspace = requireWorkspace(args.workspaceId)
  const qualified = resolveQualifiedReference(workspace, args.reference)
  const folder = qualified?.folder ?? workspace.folders.find((item) => item.role === 'primary')
  if (!folder) return null
  const resolved = await resolveFileReference(folder.path, qualified?.reference ?? args.reference, {
    allowDirectory: true,
  })
  if (!resolved) return null
  if (resolved.isDirectory) return { isDirectory: true, thumbnail: null }
  // 工作区内的引用只带相对路径，拼回工作区根；区外的 absolutePath 才是真身。
  const absolutePath = resolved.absolutePath ?? join(folder.path, resolved.relativePath)
  return { isDirectory: false, thumbnail: await readImageThumbnail(absolutePath, args.maxSize) }
}

/**
 * Chat Inline Image: 回复正文里 `![](路径)` 指向的本地图片 → data URL。
 *
 * 边长上限给得比 pill 缩略图大两个数量级——这条路径存在的理由就是二维码这类
 * "缩糊了就没用了"的图。仍然只缩不放（见 readImageThumbnail），小图原样返回。
 */
const INLINE_IMAGE_MAX_SIZE = 1024

export const readInlineImageHandler = async (args: {
  workspaceId: string
  reference: string
}): Promise<{ dataUrl: string } | null> => {
  const workspace = requireWorkspace(args.workspaceId)
  const qualified = resolveQualifiedReference(workspace, args.reference)
  const folder = qualified?.folder ?? workspace.folders.find((item) => item.role === 'primary')
  if (!folder) return null
  const resolved = await resolveFileReference(folder.path, qualified?.reference ?? args.reference)
  if (!resolved || resolved.isDirectory) return null
  const absolutePath = resolved.absolutePath ?? join(folder.path, resolved.relativePath)
  const dataUrl = await readImageThumbnail(absolutePath, INLINE_IMAGE_MAX_SIZE)
  return dataUrl ? { dataUrl } : null
}

export const openInEditorHandler = async (args: {
  workspaceId: string
  folderId?: string
  relativePath: string
  absolutePath?: string
  line?: number
  column?: number
}) => {
  let workspace: WorkspaceRecord
  let folder: WorkspaceFolderRecord
  try {
    ;({ workspace, folder } = requireWorkspaceFolder(args.workspaceId, args.folderId))
  } catch {
    return { launched: false, editor: null, error: 'workspace not found' }
  }
  // 工作区外文件（absolutePath 存在）跳过工作区边界校验，直接交由编辑器启动。
  if (!args.absolutePath) {
    try {
      await resolveWorkspaceEntry(folder.path, args.relativePath)
    } catch {
      return {
        launched: false,
        editor: null,
        error: 'file is outside the workspace or unavailable',
      }
    }
  }
  const editor = workspace.preferredEditor ?? DEFAULT_EDITOR
  return launchInEditor(editor, {
    workspacePath: folder.path,
    relativePath: args.relativePath,
    ...(args.absolutePath !== undefined && { absolutePath: args.absolutePath }),
    ...(args.line !== undefined && { line: args.line }),
    ...(args.column !== undefined && { column: args.column }),
  })
}

export const pathExistsHandler = async (args: { absolutePath: string }): Promise<boolean> => {
  return existsSync(args.absolutePath)
}

// File Tree IPC: 所有文件树、搜索和预览入口共享同一套工作区存在性校验。
function requireWorkspace(workspaceId: string) {
  const workspace = ctx.db.findWorkspaceById(workspaceId)
  if (!workspace) throw new Error('workspace not found')
  return workspace
}

function requireWorkspaceFolder(
  workspaceId: string,
  folderId?: string,
): { workspace: WorkspaceRecord; folder: WorkspaceFolderRecord } {
  const workspace = requireWorkspace(workspaceId)
  const folder = folderId
    ? workspace.folders.find((item) => item.id === folderId)
    : workspace.folders.find((item) => item.role === 'primary')
  if (!folder) throw new Error('workspace folder not found')
  return { workspace, folder }
}

function annotateEntries(entries: DirEntry[], folder: WorkspaceFolderRecord): DirEntry[] {
  return entries.map((entry) => ({
    ...entry,
    folderId: folder.id,
    folderAlias: folder.alias,
  }))
}

function resolveQualifiedReference(
  workspace: WorkspaceRecord,
  reference: string,
): { folder: WorkspaceFolderRecord; reference: string } | null {
  const normalized = reference.trim().replace(/^@/, '')
  const slash = normalized.indexOf('/')
  if (slash <= 0) return null
  const alias = normalized.slice(0, slash)
  const folder = workspace.folders.find((item) => item.alias === alias)
  return folder ? { folder, reference: normalized.slice(slash + 1) } : null
}
