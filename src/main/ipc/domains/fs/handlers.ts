import { existsSync } from 'node:fs'
import { join } from 'node:path'

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
import type { DirEntry, FilePreview, MentionPreview, ResolvedFileReference } from '@shared/ipc/fs'

// File Tree IPC: renderer 只提交 workspaceId，主进程从数据库取得可信工作区根目录。
export const readDirectoryHandler = async (args: {
  workspaceId: string
  relativePath?: string
  respectGitignore?: boolean
}): Promise<DirEntry[]> => {
  const workspace = requireWorkspace(args.workspaceId)
  return readDirectory(workspace.path, args.relativePath ?? '', args.respectGitignore ?? true)
}

export const readFilePreviewHandler = async (args: {
  workspaceId: string
  relativePath: string
  absolutePath?: string
}): Promise<FilePreview> => {
  const workspace = requireWorkspace(args.workspaceId)
  return readFilePreview(workspace.path, args.relativePath, args.absolutePath)
}

export const searchFilesHandler = async (args: {
  workspaceId: string
  query: string
  limit?: number
}): Promise<DirEntry[]> => {
  const workspace = requireWorkspace(args.workspaceId)
  return searchWorkspace(workspace.path, args.query, args.limit)
}

export const resolveFileReferenceHandler = async (args: {
  workspaceId: string
  reference: string
  allowDirectory?: boolean
}): Promise<ResolvedFileReference | null> => {
  const workspace = requireWorkspace(args.workspaceId)
  return resolveFileReference(workspace.path, args.reference, {
    allowDirectory: args.allowDirectory === true,
  })
}

export const readMentionPreviewHandler = async (args: {
  workspaceId: string
  reference: string
  maxSize?: number
}): Promise<MentionPreview | null> => {
  const workspace = requireWorkspace(args.workspaceId)
  const resolved = await resolveFileReference(workspace.path, args.reference, {
    allowDirectory: true,
  })
  if (!resolved) return null
  if (resolved.isDirectory) return { isDirectory: true, thumbnail: null }
  // 工作区内的引用只带相对路径，拼回工作区根；区外的 absolutePath 才是真身。
  const absolutePath = resolved.absolutePath ?? join(workspace.path, resolved.relativePath)
  return { isDirectory: false, thumbnail: await readImageThumbnail(absolutePath, args.maxSize) }
}

export const openInEditorHandler = async (args: {
  workspaceId: string
  relativePath: string
  absolutePath?: string
  line?: number
  column?: number
}) => {
  const ws = ctx.db.findWorkspaceById(args.workspaceId)
  if (!ws) {
    return { launched: false, editor: null, error: 'workspace not found' }
  }
  // 工作区外文件（absolutePath 存在）跳过工作区边界校验，直接交由编辑器启动。
  if (!args.absolutePath) {
    try {
      await resolveWorkspaceEntry(ws.path, args.relativePath)
    } catch {
      return {
        launched: false,
        editor: null,
        error: 'file is outside the workspace or unavailable',
      }
    }
  }
  const editor = ws.preferredEditor ?? DEFAULT_EDITOR
  return launchInEditor(editor, {
    workspacePath: ws.path,
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
