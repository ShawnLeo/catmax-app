import type { UpdateHandlers } from '@shared/ipc/update'

import { handleRendererRequest } from '../../typed'

import { applyUpdateNow, checkUpdateNow, getUpdateStatus } from './handlers'

export function registerUpdateHandlers(): void {
  handleRendererRequest<UpdateHandlers, 'update.getStatus'>('update.getStatus', getUpdateStatus)
  handleRendererRequest<UpdateHandlers, 'update.check'>('update.check', checkUpdateNow)
  handleRendererRequest<UpdateHandlers, 'update.apply'>('update.apply', applyUpdateNow)
}

export type { UpdateHandlers } from '@shared/ipc/update'
