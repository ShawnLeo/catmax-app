import type { FsHandlers } from '@shared/ipc/fs'

import { handleRendererRequest } from '../../typed'

import {
  openInEditorHandler,
  pathExistsHandler,
  readDirectoryHandler,
  readFilePreviewHandler,
  readInlineImageHandler,
  readMentionPreviewHandler,
  resolveFileReferenceHandler,
  searchFilesHandler,
} from './handlers'

export function registerFsHandlers(): void {
  // File Tree IPC: 目录、搜索、引用解析和预览必须成组注册，保持 preload 契约完整。
  handleRendererRequest<FsHandlers, 'fs.readDirectory'>('fs.readDirectory', readDirectoryHandler)
  handleRendererRequest<FsHandlers, 'fs.readFilePreview'>(
    'fs.readFilePreview',
    readFilePreviewHandler,
  )
  handleRendererRequest<FsHandlers, 'fs.searchFiles'>('fs.searchFiles', searchFilesHandler)
  handleRendererRequest<FsHandlers, 'fs.resolveFileReference'>(
    'fs.resolveFileReference',
    resolveFileReferenceHandler,
  )
  handleRendererRequest<FsHandlers, 'fs.openInEditor'>('fs.openInEditor', openInEditorHandler)
  handleRendererRequest<FsHandlers, 'fs.pathExists'>('fs.pathExists', pathExistsHandler)
  handleRendererRequest<FsHandlers, 'fs.readMentionPreview'>(
    'fs.readMentionPreview',
    readMentionPreviewHandler,
  )
  handleRendererRequest<FsHandlers, 'fs.readInlineImage'>(
    'fs.readInlineImage',
    readInlineImageHandler,
  )
}

export type { FsHandlers } from '@shared/ipc/fs'
