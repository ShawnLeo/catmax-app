import type { SettingsHandlers } from '@shared/ipc/settings'

import { handleRendererRequest } from '../../typed'

import { getSettings, resetSettings, updateSettings } from './handlers'

export function registerSettingsHandlers(): void {
  handleRendererRequest<SettingsHandlers, 'settings.get'>('settings.get', getSettings)
  handleRendererRequest<SettingsHandlers, 'settings.update'>('settings.update', updateSettings)
  handleRendererRequest<SettingsHandlers, 'settings.reset'>('settings.reset', resetSettings)
}

export type { SettingsHandlers } from '@shared/ipc/settings'
