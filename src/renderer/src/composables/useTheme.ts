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

  /**
   * 把某条字号基准写到 <html> 的行内样式上。
   *
   * 三条基准（界面 / 对话 / 等宽）的刻度都由各自的基准变量派生（见 themes.css），
   * 所以改一个变量就整体缩放，组件里不需要任何字号相关的响应式代码。
   * 传 undefined 时清掉行内值，退回 themes.css 里的兜底默认。
   */
  function applyFontSizeVar(name: string, size: number | undefined): void {
    if (typeof size === 'number' && Number.isFinite(size)) {
      document.documentElement.style.setProperty(name, `${size}px`)
    } else {
      document.documentElement.style.removeProperty(name)
    }
  }

  /** 对话正文与 Markdown 的基准（settings.theme.chatFontSize）。 */
  function applyChatFontSize(size: number | undefined): void {
    applyFontSizeVar('--chat-font-size', size)
  }

  /**
   * 代码块 / diff / 终端的基准（settings.theme.codeFontSize）。
   *
   * 只覆盖纯 CSS 的等宽区域。终端和 DiffView 的字号是 JS 参数，读不到 CSS 变量，
   * 它们各自从 settings 取同一个字段——见 TerminalPanel / DiffView。
   */
  function applyCodeFontSize(size: number | undefined): void {
    applyFontSizeVar('--code-font-size', size)
  }

  /**
   * 界面基准（settings.theme.fontSize）：聊天区之外的全部界面——
   * 侧边栏 / 右侧面板 / 设置页 / 命令面板 / 标题栏。
   */
  function applyUiFontSize(size: number | undefined): void {
    applyFontSizeVar('--ui-font-size', size)
  }

  function apply(mode: ThemeMode): void {
    const effective = resolveEffective(mode)
    document.documentElement.setAttribute('data-theme', effective)
    applyUiFontSize(settings.settings?.theme.fontSize)
    applyChatFontSize(settings.settings?.theme.chatFontSize)
    applyCodeFontSize(settings.settings?.theme.codeFontSize)

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

  return { apply, applyChatFontSize, applyCodeFontSize, applyUiFontSize, setMode }
}
