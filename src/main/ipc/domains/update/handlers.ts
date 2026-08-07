/**
 * Hot Update IPC handlers。
 *
 * 这里只做转发——所有判定（验签、版本守门、活跃 turn 门禁）都在
 * `service/hot-update.ts` 里，因为托盘菜单也要用同一套结论，不能挂在 IPC 层。
 */
import type { HotUpdateStatus } from '@shared/ipc/update'

import { applyUpdate, checkForUpdate, getStatus } from '../../../service/hot-update'

export async function getUpdateStatus(): Promise<HotUpdateStatus> {
  return getStatus()
}

export async function checkUpdateNow(): Promise<HotUpdateStatus> {
  return checkForUpdate(true)
}

export async function applyUpdateNow(): Promise<{ ok: boolean; reason?: string }> {
  return applyUpdate()
}
