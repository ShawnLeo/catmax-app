/**
 * AppSettings 类型 + Zod schema。
 * settings.json 是磁盘上的不可信输入，加载时必须用 schema 校验。
 */
import { z } from 'zod'

import { BACKEND_IDS, DEFAULT_FONT_SIZE, DEFAULT_THEME_MODE, EDITOR_IDS } from './constants'

export const themeModeSchema = z.enum(['light', 'dark', 'system'])
export type ThemeMode = z.infer<typeof themeModeSchema>

export const fontFamilySchema = z.object({
  sans: z.string().nullable(),
  chat: z.string().nullable(),
  mono: z.string().nullable(),
})

export const themeSettingsSchema = z.object({
  mode: themeModeSchema.default(DEFAULT_THEME_MODE),
  fontFamily: fontFamilySchema.default({ sans: null, chat: null, mono: null }),
  fontSize: z.number().int().min(11).max(20).default(DEFAULT_FONT_SIZE),
  chatFontSize: z.number().int().min(11).max(20).default(15),
  codeFontSize: z.number().int().min(10).max(18).default(13),
})
export type ThemeSettings = z.infer<typeof themeSettingsSchema>

export const httpProxySchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().nullable().default(null),
  bypass: z.string().nullable().default(null),
})
export type HttpProxy = z.infer<typeof httpProxySchema>

export const appSettingsSchema = z.object({
  defaultBackend: z.enum(BACKEND_IDS).default('codex'),
  backendPaths: z
    .object({
      codex: z.string().nullable().default(null),
      claude: z.string().nullable().default(null),
    })
    .default({ codex: null, claude: null }),
  defaultEditor: z.enum(EDITOR_IDS).default('vscode'),
  theme: themeSettingsSchema.default({}),
  httpProxy: httpProxySchema.default({}),
  language: z.enum(['zh-CN', 'en-US']).default('zh-CN'),
  sendOnEnter: z.boolean().default(true),
  showReasoningByDefault: z.boolean().default(false),
  sidebarWidth: z.number().int().min(200).max(600).default(240),
  rightPanelWidth: z.number().int().min(200).max(800).default(320),
  bottomPanelHeight: z.number().int().min(100).max(600).default(320),
})
export type AppSettings = z.infer<typeof appSettingsSchema>
