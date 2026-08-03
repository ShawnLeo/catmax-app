import { ctx } from '@main/context'
import type { AuthStatus } from '@shared/ipc/auth'

/**
 * 内测登录态 IPC handlers。
 * 全部委托给 ctx.authStore 单例——它负责内存缓存 + 落盘。
 */

export const getAuthStatus = async (): Promise<AuthStatus> => {
  return ctx.authStore.getStatus()
}

export const authLogin = async (args: { secretKey: string }): Promise<AuthStatus> => {
  return ctx.authStore.login(args.secretKey)
}

export const authLogout = async (): Promise<AuthStatus> => {
  return ctx.authStore.logout()
}
