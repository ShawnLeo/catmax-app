import { ctx } from '@main/context'
import type { AppSettings } from '@shared/settings-schema'

export const getSettings = async (): Promise<AppSettings> => {
  return ctx.settingsStore.load()
}

export const updateSettings = async (args: {
  patch: Partial<AppSettings>
}): Promise<AppSettings> => {
  return ctx.settingsStore.update(args.patch)
}

export const resetSettings = async (): Promise<AppSettings> => {
  return ctx.settingsStore.reset()
}
