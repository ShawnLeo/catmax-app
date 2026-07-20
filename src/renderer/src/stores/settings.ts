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
    // IPC 走 structured clone，Vue 的 reactive Proxy 不能跨进程序列化
    // （报 "An object could not be cloned"）。调用方常常从 store 里 spread 出 patch，
    // 比如 `{ theme: { ...settings.settings.theme, mode } }`——顶层是普通对象，
    // 但嵌套的 fontFamily 等仍是 Proxy。这里深拷贝成纯对象再过 IPC。
    const plain = JSON.parse(JSON.stringify(patch)) as Partial<AppSettings>
    settings.value = await window.api.settings.update({ patch: plain })
  }

  async function reset(): Promise<void> {
    settings.value = await window.api.settings.reset()
  }

  return { settings, loading, load, update, reset }
})
