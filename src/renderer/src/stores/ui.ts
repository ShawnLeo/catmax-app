import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useUiStore = defineStore('ui', () => {
  const sidebarCollapsed = ref(false)
  const settingsDialogOpen = ref(false)

  function toggleSidebar(): void {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  function openSettings(): void {
    settingsDialogOpen.value = true
  }

  function closeSettings(): void {
    settingsDialogOpen.value = false
  }

  return { sidebarCollapsed, settingsDialogOpen, toggleSidebar, openSettings, closeSettings }
})
