import { defineStore } from 'pinia'
import { ref } from 'vue'

const DEFAULT_SIDEBAR_WIDTH = 240
const DEFAULT_RIGHT_PANEL_WIDTH = 320
const DEFAULT_BOTTOM_PANEL_HEIGHT = 320

export const useUiStore = defineStore('ui', () => {
  const sidebarCollapsed = ref(false)
  const settingsDialogOpen = ref(false)
  const rightPanelVisible = ref(false)
  const bottomPanelVisible = ref(false)
  const commandPaletteVisible = ref(false)

  const sidebarWidth = ref(DEFAULT_SIDEBAR_WIDTH)
  const rightPanelWidth = ref(DEFAULT_RIGHT_PANEL_WIDTH)
  const bottomPanelHeight = ref(DEFAULT_BOTTOM_PANEL_HEIGHT)

  // 拖拽 resize 期间为 true：面板关掉 transition（避免动画追赶造成卡顿），
  // 且 setSidebarWidth 等不再每帧写盘（拖拽结束统一持久化一次）。
  const panelDragging = ref(false)

  function startPanelDrag(): void {
    panelDragging.value = true
  }

  function endPanelDrag(): void {
    panelDragging.value = false
    saveWidths()
  }

  function setSidebarWidth(width: number): void {
    sidebarWidth.value = width
    if (!panelDragging.value) saveWidths()
  }

  function setRightPanelWidth(width: number): void {
    rightPanelWidth.value = width
    if (!panelDragging.value) saveWidths()
  }

  function setBottomPanelHeight(height: number): void {
    bottomPanelHeight.value = height
    if (!panelDragging.value) saveWidths()
  }

  function loadWidths(
    sidebarWidthFromSettings: number | undefined,
    rightPanelWidthFromSettings: number | undefined,
    bottomPanelHeightFromSettings: number | undefined,
  ): void {
    if (sidebarWidthFromSettings !== undefined) {
      sidebarWidth.value = sidebarWidthFromSettings
    }
    if (rightPanelWidthFromSettings !== undefined) {
      rightPanelWidth.value = rightPanelWidthFromSettings
    }
    if (bottomPanelHeightFromSettings !== undefined) {
      bottomPanelHeight.value = bottomPanelHeightFromSettings
    }
  }

  async function saveWidths(): Promise<void> {
    const { useSettingsStore } = await import('@renderer/stores/settings')
    const settingsStore = useSettingsStore()
    if (settingsStore.settings) {
      await settingsStore.update({
        sidebarWidth: sidebarWidth.value,
        rightPanelWidth: rightPanelWidth.value,
        bottomPanelHeight: bottomPanelHeight.value,
      })
    }
  }

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

  function toggleBottomPanel(): void {
    bottomPanelVisible.value = !bottomPanelVisible.value
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
    bottomPanelVisible,
    commandPaletteVisible,
    sidebarWidth,
    rightPanelWidth,
    bottomPanelHeight,
    panelDragging,
    startPanelDrag,
    endPanelDrag,
    setSidebarWidth,
    setRightPanelWidth,
    setBottomPanelHeight,
    toggleSidebar,
    openSettings,
    closeSettings,
    toggleRightPanel,
    toggleBottomPanel,
    openCommandPalette,
    closeCommandPalette,
    toggleCommandPalette,
    loadWidths,
  }
})
