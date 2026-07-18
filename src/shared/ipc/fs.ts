/**
 * fs domain IPC 契约。
 * 函数签名即契约——main 实现，renderer 通过 window.api 调用。
 *
 * 这些函数本体在 shared 里只声明签名（抛 Not Implemented），
 * 真实实现在 main/ipc/domains/fs/handlers.ts。
 */
import type { EditorId } from '../constants'

export interface DirEntry {
  name: string
  relativePath: string
  isDirectory: boolean
  isSymlink: boolean
  size: number
  modifiedAt: number
}

export interface FilePreview {
  relativePath: string
  absolutePath: string
  size: number
  mimeType: string
  isBinary: boolean
  content: string | null
  language: string | null
  truncated: boolean
  encoding: 'utf-8' | 'binary'
}

// stub 参数名以 `_` 前缀避免 unused 报错；参数类型从 typeof 派生不受影响。
export async function readDirectory(_args: {
  workspacePath: string
  relativePath?: string
  respectGitignore?: boolean
}): Promise<DirEntry[]> {
  throw new Error('implemented in main')
}

export async function readFilePreview(_args: {
  workspacePath: string
  relativePath: string
}): Promise<FilePreview> {
  throw new Error('implemented in main')
}

export async function openInEditor(_args: {
  workspaceId: string
  relativePath: string
  line?: number
  column?: number
}): Promise<{ launched: boolean; editor: EditorId | null; error?: string }> {
  throw new Error('implemented in main')
}

export async function pathExists(_args: { absolutePath: string }): Promise<boolean> {
  throw new Error('implemented in main')
}

/** 聚合类型：所有 fs handler 的 channel → 签名映射 */
export type FsHandlers = {
  'fs.readDirectory': typeof readDirectory
  'fs.readFilePreview': typeof readFilePreview
  'fs.openInEditor': typeof openInEditor
  'fs.pathExists': typeof pathExists
}
