import type { FsHandlers } from '@shared/ipc/fs'

import { handleRendererRequest } from '../../typed'

import {
  openInEditorHandler,
  pathExistsHandler,
  readDirectoryHandler,
  readFilePreviewHandler,
} from './handlers'

export function registerFsHandlers(): void {
  handleRendererRequest<FsHandlers, 'fs.readDirectory'>('fs.readDirectory', readDirectoryHandler)
  handleRendererRequest<FsHandlers, 'fs.readFilePreview'>(
    'fs.readFilePreview',
    readFilePreviewHandler,
  )
  handleRendererRequest<FsHandlers, 'fs.openInEditor'>('fs.openInEditor', openInEditorHandler)
  handleRendererRequest<FsHandlers, 'fs.pathExists'>('fs.pathExists', pathExistsHandler)
}

export type { FsHandlers } from '@shared/ipc/fs'
