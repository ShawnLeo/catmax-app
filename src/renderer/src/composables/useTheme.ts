import { useSettingsStore } from '@renderer/stores/settings'
import type { ThemeMode } from '@shared/settings-schema'

let mediaQuery: MediaQueryList | null = null
let mediaListener: ((e: MediaQueryListEvent) => void) | null = null

export function useTheme() {
  const settings = useSettingsStore()

  function resolveEffective(mode: ThemeMode): 'dark' | 'light' {
    if (mode === 'system') {
      if (!mediaQuery) {
        mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      }
      return mediaQuery.matches ? 'dark' : 'light'
    }
    return mode
  }

  function apply(mode: ThemeMode): void {
    const effective = resolveEffective(mode)
    document.documentElement.setAttribute('data-theme', effective)

    if (mode === 'system') {
      startSystemListener()
    } else {
      stopSystemListener()
    }
  }

  function startSystemListener(): void {
    if (!mediaQuery) {
      mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    }
    if (mediaListener) return
    mediaListener = () => {
      const currentMode = settings.settings?.theme.mode ?? 'system'
      if (currentMode === 'system') {
        const effective = mediaQuery!.matches ? 'dark' : 'light'
        document.documentElement.setAttribute('data-theme', effective)
      }
    }
    mediaQuery.addEventListener('change', mediaListener)
  }

  function stopSystemListener(): void {
    if (mediaQuery && mediaListener) {
      mediaQuery.removeEventListener('change', mediaListener)
      mediaListener = null
    }
  }

  async function setMode(mode: ThemeMode): Promise<void> {
    await settings.update({ theme: { ...settings.settings!.theme, mode } })
    apply(mode)
  }

  return { apply, setMode }
}
