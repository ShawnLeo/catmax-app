import type { Config } from 'tailwindcss'

/**
 * Tailwind v4 主要在 CSS 中用 @theme 配置（见 main.css）。
 * 这里保留少量 JS 配置（darkMode 策略，但本项目用 data-theme 不用 dark:）。
 */
export default {
  darkMode: ['selector', '[data-theme="dark"]'],
} satisfies Config
