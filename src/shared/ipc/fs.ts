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

// File Preview Contract: kind 决定 renderer 使用代码、媒体、表格或占位预览器。
export type FilePreviewKind =
  | 'text'
  | 'markdown'
  | 'table'
  | 'image'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'document'
  | 'archive'
  | 'binary'

export interface FilePreview {
  relativePath: string
  absolutePath: string
  name: string
  size: number
  mimeType: string
  kind: FilePreviewKind
  isBinary: boolean
  content: string | null
  dataUrl: string | null
  language: string | null
  truncated: boolean
  encoding: 'utf-8' | 'binary'
  modifiedAt: number
}

// File Tree IPC Contract: stub 参数名以 `_` 前缀避免 unused，签名由 main/preload 共用。
export async function readDirectory(_args: {
  workspaceId: string
  /**
   * 仅用于兼容开发时 renderer 已热更新、main/preload 尚未重启的旧进程。
   * 新版 main 始终通过 workspaceId 从数据库解析可信路径。
   */
  workspacePath?: string
  relativePath?: string
  respectGitignore?: boolean
}): Promise<DirEntry[]> {
  throw new Error('implemented in main')
}

/**
 * Resolved File Reference:
 * resolveFileReference 的返回结构。工作区内文件只填 relativePath（向后兼容）；
 * 工作区外文件（家目录、绝对路径指向工作区外）额外填 absolutePath，
 * 此时 relativePath 退化为展示用的原始引用形态（如 `~/.claude.json`）。
 */
export interface ResolvedFileReference {
  relativePath: string
  /** 工作区外文件的真实绝对路径；存在时下游 readFilePreview/openInEditor 走绝对路径直读。 */
  absolutePath?: string
  line?: number
  column?: number
}

export async function readFilePreview(_args: {
  workspaceId: string
  /** @see readDirectory 的 workspacePath 兼容说明。 */
  workspacePath?: string
  relativePath: string
  /**
   * 工作区外文件（如 `~/.claude.json`）的绝对路径。
   * 存在时跳过工作区边界校验，直接按绝对路径读取（仍受常规文件 + 大小限制约束）。
   */
  absolutePath?: string
}): Promise<FilePreview> {
  throw new Error('implemented in main')
}

export async function searchFiles(_args: {
  workspaceId: string
  /** @see readDirectory 的 workspacePath 兼容说明。 */
  workspacePath?: string
  query: string
  limit?: number
}): Promise<DirEntry[]> {
  throw new Error('implemented in main')
}

export async function resolveFileReference(_args: {
  workspaceId: string
  /** @see readDirectory 的 workspacePath 兼容说明。 */
  workspacePath?: string
  reference: string
}): Promise<ResolvedFileReference | null> {
  throw new Error('implemented in main')
}

export async function openInEditor(_args: {
  workspaceId: string
  relativePath: string
  /** 工作区外文件的绝对路径，存在时直接以此路径打开编辑器。 */
  absolutePath?: string
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
  'fs.searchFiles': typeof searchFiles
  'fs.resolveFileReference': typeof resolveFileReference
  'fs.openInEditor': typeof openInEditor
  'fs.pathExists': typeof pathExists
}
