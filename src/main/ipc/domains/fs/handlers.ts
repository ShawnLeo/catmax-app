import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'

import { ctx } from '@main/context'
import { launchInEditor } from '@main/service/editor-launcher'
import { detectLanguage, isBinaryContent, readDirectory } from '@main/service/file-tree'
import { DEFAULT_EDITOR } from '@shared/constants'
import type { DirEntry, FilePreview } from '@shared/ipc/fs'

const MAX_PREVIEW_BYTES = 256 * 1024

export const readDirectoryHandler = async (args: {
  workspacePath: string
  relativePath?: string
  respectGitignore?: boolean
}): Promise<DirEntry[]> => {
  return readDirectory(args.workspacePath, args.relativePath ?? '', args.respectGitignore ?? true)
}

export const readFilePreviewHandler = async (args: {
  workspacePath: string
  relativePath: string
}): Promise<FilePreview> => {
  const absPath = join(args.workspacePath, args.relativePath)
  if (!existsSync(absPath)) {
    throw new Error(`file does not exist: ${args.relativePath}`)
  }

  const stat = await fs.stat(absPath)
  const buffer = await fs.readFile(absPath)
  const binary = isBinaryContent(buffer)
  const truncated = buffer.length > MAX_PREVIEW_BYTES
  const sliced = truncated ? buffer.subarray(0, MAX_PREVIEW_BYTES) : buffer

  let content: string | null = null
  let language: string | null = null
  if (!binary) {
    content = sliced.toString('utf-8')
    language = detectLanguage(args.relativePath)
  }

  return {
    relativePath: args.relativePath,
    absolutePath: absPath,
    size: stat.size,
    mimeType: binary ? 'application/octet-stream' : 'text/plain',
    isBinary: binary,
    content,
    language,
    truncated,
    encoding: binary ? 'binary' : 'utf-8',
  }
}

export const openInEditorHandler = async (args: {
  workspaceId: string
  relativePath: string
  line?: number
  column?: number
}) => {
  const ws = ctx.db.findWorkspaceById(args.workspaceId)
  if (!ws) {
    return { launched: false, editor: null, error: 'workspace not found' }
  }
  const editor = ws.preferredEditor ?? DEFAULT_EDITOR
  return launchInEditor(editor, {
    workspacePath: ws.path,
    relativePath: args.relativePath,
    ...(args.line !== undefined && { line: args.line }),
    ...(args.column !== undefined && { column: args.column }),
  })
}

export const pathExistsHandler = async (args: { absolutePath: string }): Promise<boolean> => {
  return existsSync(args.absolutePath)
}
