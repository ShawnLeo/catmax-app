import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useUiStore = defineStore('ui', () => {
  const sidebarCollapsed = ref(false)
  const settingsDialogOpen = ref(false)
  const rightPanelVisible = ref(false)
  const commandPaletteVisible = ref(false)

  function toggleSidebar(): void {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  function openSettings(): void {
    settingsDialogOpen.value = true
  }

  function closeSettings(): void {
    settingsDialogOpen.value = false
  }

  function toggleRightPanel(): void {
    rightPanelVisible.value = !rightPanelVisible.value
  }

  function openCommandPalette(): void {
    commandPaletteVisible.value = true
  }

  function closeCommandPalette(): void {
    commandPaletteVisible.value = false
  }

  function toggleCommandPalette(): void {
    commandPaletteVisible.value = !commandPaletteVisible.value
  }

  return {
    sidebarCollapsed,
    settingsDialogOpen,
    rightPanelVisible,
    commandPaletteVisible,
    toggleSidebar,
    openSettings,
    closeSettings,
    toggleRightPanel,
    openCommandPalette,
    closeCommandPalette,
    toggleCommandPalette,
  }
})
