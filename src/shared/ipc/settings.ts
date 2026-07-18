import type { AppSettings } from '../settings-schema'

export type SettingsHandlers = {
  'settings.get': () => Promise<AppSettings>
  'settings.update': (args: { patch: Partial<AppSettings> }) => Promise<AppSettings>
  'settings.reset': () => Promise<AppSettings>
}
