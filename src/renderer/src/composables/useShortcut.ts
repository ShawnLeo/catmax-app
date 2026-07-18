import { onMounted, onUnmounted } from 'vue'

/**
 * 全局快捷键 composable。
 * 用法：
 *   useShortcut('mod+k', () => openPalette())
 *
 * 'mod' 自动映射为 macOS 的 Cmd / 其他的 Ctrl。
 */
export function useShortcut(shortcut: string, callback: () => void): void {
  const handler = (e: KeyboardEvent) => {
    const parts = shortcut.toLowerCase().split('+')
    const wantMod = parts.includes('mod') || parts.includes('cmd') || parts.includes('ctrl')
    const wantShift = parts.includes('shift')
    const wantAlt = parts.includes('alt')
    const key = parts[parts.length - 1]

    const isMod = e.metaKey || e.ctrlKey
    if (wantMod !== isMod) return
    if (wantShift !== e.shiftKey) return
    if (wantAlt !== e.altKey) return
    if (e.key.toLowerCase() !== key) return

    e.preventDefault()
    callback()
  }

  onMounted(() => window.addEventListener('keydown', handler))
  onUnmounted(() => window.removeEventListener('keydown', handler))
}
