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
  folderId?: string
  folderAlias?: string
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
  folderId?: string
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
  /** File Mention: 引用指向的是目录——仅在调用方传了 allowDirectory 时可能为 true。 */
  isDirectory?: boolean
  folderId?: string
  folderAlias?: string
}

export async function readFilePreview(_args: {
  workspaceId: string
  folderId?: string
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
  folderId?: string
  /** Composer 使用：跨工作区全部主/次文件夹聚合搜索。 */
  allFolders?: boolean
  /** @see readDirectory 的 workspacePath 兼容说明。 */
  workspacePath?: string
  query: string
  limit?: number
}): Promise<DirEntry[]> {
  throw new Error('implemented in main')
}

export async function resolveFileReference(_args: {
  workspaceId: string
  folderId?: string
  /** @see readDirectory 的 workspacePath 兼容说明。 */
  workspacePath?: string
  reference: string
  /**
   * File Mention: 允许解析到目录（默认 false，只认常规文件）。
   * 预览通道必须保持 false——目录进了 readFilePreview 只会报错；
   * 只有"引用进对话"才需要它（拖入文件夹、右键点在目录上）。
   */
  allowDirectory?: boolean
}): Promise<ResolvedFileReference | null> {
  throw new Error('implemented in main')
}

export async function openInEditor(_args: {
  workspaceId: string
  folderId?: string
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

/** File Mention: 一条引用在 pill 上要显示什么，见 readMentionPreview。 */
export interface MentionPreview {
  /** 引用指向的是目录——pill 用它决定画文件夹图标还是文件图标 */
  isDirectory: boolean
  /** 图片缩略图 data URL；非图片、目录、或文件大到不值得解码时为 null */
  thumbnail: string | null
}

/**
 * File Mention: 一次拿全引用 pill 需要的信息；引用解析不到时返回 null。
 *
 * 「是不是目录」和「有没有缩略图」合在一个 IPC 里，因为它们来自同一次路径解析——
 * 拆成两个方法等于每条 pill 都要往返两次，还得处理两次答案不一致的情况。
 *
 * 收的是 `reference` 而不是拆好的相对/绝对路径——调用方（引用 pill）手里只有
 * 展示用的那一串，形态可能是工作区相对路径、`~/…` 或绝对路径，正好是
 * resolveFileReference 已经在处理的三种。
 *
 * 缩放在主进程做：渲染层只需要一个 16px 的方块，没有理由让一张几 MB 的照片
 * 以 base64 的形态进它的内存。
 */
export async function readMentionPreview(_args: {
  workspaceId: string
  reference: string
  /** 缩略图边长上限，默认 96 */
  maxSize?: number
}): Promise<MentionPreview | null> {
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
  'fs.readMentionPreview': typeof readMentionPreview
}
