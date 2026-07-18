import type { AppSettings } from '@shared/settings-schema'
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings | null>(null)
  const loading = ref(false)

  async function load(): Promise<void> {
    loading.value = true
    try {
      settings.value = await window.api.settings.get()
    } finally {
      loading.value = false
    }
  }

  async function update(patch: Partial<AppSettings>): Promise<void> {
    settings.value = await window.api.settings.update({ patch })
  }

  async function reset(): Promise<void> {
    settings.value = await window.api.settings.reset()
  }

  return { settings, loading, load, update, reset }
})
