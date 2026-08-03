import type { AuthHandlers } from '@shared/ipc/auth'

import { handleRendererRequest } from '../../typed'

import { authLogin, authLogout, getAuthStatus } from './handlers'

export function registerAuthHandlers(): void {
  handleRendererRequest<AuthHandlers, 'auth.getStatus'>('auth.getStatus', getAuthStatus)
  handleRendererRequest<AuthHandlers, 'auth.login'>('auth.login', authLogin)
  handleRendererRequest<AuthHandlers, 'auth.logout'>('auth.logout', authLogout)
}

export type { AuthHandlers } from '@shared/ipc/auth'
