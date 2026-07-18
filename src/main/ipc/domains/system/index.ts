import type { SystemHandlers } from '@shared/ipc/system'

import { handleRendererRequest } from '../../typed'

import { getPlatformInfo, openDialog, openExternal } from './handlers'

export function registerSystemHandlers(): void {
  handleRendererRequest<SystemHandlers, 'system.platformInfo'>(
    'system.platformInfo',
    getPlatformInfo,
  )
  handleRendererRequest<SystemHandlers, 'system.openDialog'>('system.openDialog', openDialog)
  handleRendererRequest<SystemHandlers, 'system.openExternal'>('system.openExternal', openExternal)
}

export type { SystemHandlers } from '@shared/ipc/system'
