/**
 * AppSettings 类型 + Zod schema。
 * settings.json 是磁盘上的不可信输入，加载时必须用 schema 校验。
 */
import { z } from 'zod'

import {
  DEFAULT_CHAT_FONT_SIZE,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_FONT_SIZE,
  DEFAULT_THEME_MODE,
  EDITOR_IDS,
} from './constants'

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
  // 聊天区正文基准字号，驱动 --chat-font-size 及其派生刻度（themes.css）。
  // 默认 13 = 该字段被真正接上之前，聊天组件里写死的那个基准，保证新装用户观感不变。
  chatFontSize: z.number().int().min(11).max(20).default(DEFAULT_CHAT_FONT_SIZE),
  codeFontSize: z.number().int().min(10).max(18).default(DEFAULT_CODE_FONT_SIZE),
})
export type ThemeSettings = z.infer<typeof themeSettingsSchema>

export const httpProxySchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().nullable().default(null),
  bypass: z.string().nullable().default(null),
})
export type HttpProxy = z.infer<typeof httpProxySchema>

/**
 * 单个 backend 的默认运行时配置（model / effort / permissionMode）。
 *
 * 全按 backend 分别配——codex 和 claude 的 model id 不互通、effort/permissionMode
 * 支持的档位也不同（codex 3 档权限 / claude 6 档）。所有字段允许 null，
 * null 表示"未配置"，由 ChatView 兜底到硬编码默认（effort='medium', permissionMode='default'）。
 */
const backendRuntimeDefaultsSchema = z.object({
  model: z.string().nullable().default(null),
  effort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']).nullable().default(null),
  permissionMode: z
    .enum(['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'])
    .nullable()
    .default(null),
})
export type BackendRuntimeDefaults = z.infer<typeof backendRuntimeDefaultsSchema>

/**
 * Protocol Bridge: 协议桥设置。
 *
 * 这里**只存非机密的元信息**——上游密钥要么在环境变量里（credentialSource='env'，
 * 只存变量名），要么在 userData 下单独的 0600 文件里（见 service/bridge-credentials.ts）。
 * settings.json 是 0644、会被备份同步、renderer 能整份读走，绝不能放密钥。
 */
/**
 * 注意：这里是普通 z.object（非 .strict()），未知键会被**静默剥掉**而不是报错。
 * 这正是删字段的向后兼容保障——旧 settings.json 里残留的 `respectsThinkingBudget`
 * （一个从未被任何 codec 读取的开关，已移除）不会让整份配置校验失败。
 */
const upstreamCapabilitiesSchema = z.object({
  supportsImages: z.boolean().default(true),
  dropSamplingWhenThinking: z.boolean().default(true),
  /**
   * 把上游的思考签名塞进回给 codex 的 `encrypted_content`。
   *
   * 默认关：这个字段会被 codex **写进 rollout 永久保存**，而里面装的是桥自己的封装
   * （`catmax-bridge-v1:` 前缀）。关桥后 codex 把同一段历史发给 ChatGPT，ChatGPT 会
   * 尝试验证它并失败——`The encrypted content for item rs_... could not be verified`，
   * 整个会话再也发不出消息。开着桥建的会话就这样被"毒"住了。
   *
   * 只有真正需要它的上游才值得付这个代价：官方 Anthropic 在 tool use 多轮里要求
   * thinking 块带原样签名。DeepSeek 这类兼容实现返回的签名只有 36 字符（实测），
   * 不是密码学签名；不回传时桥会把 thinking 降级成普通文本（见 anthropic-messages.ts），
   * 语义不丢，也就没必要冒污染 rollout 的风险。
   */
  preserveThinkingSignature: z.boolean().default(false),
  defaultMaxOutputTokens: z.number().int().min(256).max(200_000).default(8192),
  toolNameMaxLength: z.number().int().min(16).max(256).default(64),
})

const bridgeProviderSchema = z.object({
  id: z.string(),
  name: z.string().default(''),
  presetId: z.string().default('custom'),
  createdAt: z.number().int().default(0),
  protocol: z.enum(['anthropic.messages']).default('anthropic.messages'),
  baseUrl: z.string().default(''),
  /** 模型列表端点完整 URL；常与 baseUrl 不同路径（见 bridge-config.ts） */
  modelsUrl: z.string().default(''),
  model: z.string().nullable().default(null),
  credentialSource: z.enum(['env', 'stored']).default('stored'),
  credentialEnvVar: z.string().default(''),
  /** 认证头方案：x-api-key（标准 Anthropic，默认）或 bearer（Authorization: Bearer） */
  authScheme: z.enum(['x-api-key', 'bearer']).default('x-api-key'),
  capabilities: upstreamCapabilitiesSchema.default({}),
  modelListMode: z.enum(['auto', 'manual']).default('auto'),
  manualModels: z.array(z.string()).default([]),
})

const protocolBridgeSchema = z.object({
  enabled: z.boolean().default(false),
  /** 当前启用的 provider id；为空字符串表示未选任何配置 */
  currentProviderId: z.string().default(''),
  providers: z.record(z.string(), bridgeProviderSchema).default({}),
})
export type ProtocolBridgeSettings = z.infer<typeof protocolBridgeSchema>

/** 主窗口上次关闭时的原生状态；坐标允许为负数（左侧/上方的外接显示器）。 */
export const windowStateSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  maximized: z.boolean().default(false),
  fullScreen: z.boolean().default(false),
  alwaysOnTop: z.boolean().default(false),
})
export type WindowState = z.infer<typeof windowStateSchema>

/**
 * 面板尺寸的持久化上下限。
 *
 * 这组数只负责挡住明显不合法的值（负数、NaN、几千像素的脏数据），不承担布局策略——
 * 用户实际能拖到哪由运行时按容器算（见 ChatView 的 sidebarMax / rightPanelMax /
 * bottomPanelMax）。两边曾经各写各的数：UI 允许拖到容器的 78%，schema 却卡在 800，
 * 超出的宽度在 settings.update 时被 Zod 打回，控制台刷 ZodError 而拖拽当下毫无反馈，
 * 重启后宽度还退回旧值。所以上限取"任何屏幕都够用"的量级，并由 ui store 在写入口兜底 clamp。
 */
export const PANEL_SIZE_LIMITS = {
  sidebarWidth: { min: 200, max: 2000 },
  rightPanelWidth: { min: 200, max: 4000 },
  bottomPanelHeight: { min: 100, max: 2000 },
} as const

export const appSettingsSchema = z.object({
  defaultBackend: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]*$/)
    // 默认 claude——它是随 @anthropic-ai/claude-agent-sdk 内置打包的后端，
    // healthCheck 恒为 ok；codex 是可选外部 CLI，未安装时不能作为默认后端
    // （否则全新机器上 BackendSection 的 Setup Gate 会把运行时配置全部藏住，
    // 用户卡在不可用的 codex 上无法切到 claude）。
    .default('claude'),
  backendPaths: z
    .object({
      codex: z.string().nullable().default(null),
      claude: z.string().nullable().default(null),
    })
    .catchall(z.string().nullable())
    .default({ codex: null, claude: null }),
  /**
   * 默认运行时配置——仅在无 last-used 时兜底（last-used 优先）。
   * 按 backend 分别配（codex / claude 各一组 model/effort/permissionMode）。
   */
  defaultRuntimeConfig: z
    .object({
      codex: backendRuntimeDefaultsSchema.default({}),
      claude: backendRuntimeDefaultsSchema.default({}),
    })
    .catchall(backendRuntimeDefaultsSchema)
    .default({ codex: {}, claude: {} }),
  /** Protocol Bridge: codex 接非 Responses 协议上游时用的本地转换桥 */
  protocolBridge: protocolBridgeSchema.default({}),
  defaultEditor: z.enum(EDITOR_IDS).default('vscode'),
  theme: themeSettingsSchema.default({}),
  httpProxy: httpProxySchema.default({}),
  language: z.enum(['zh-CN', 'en-US']).default('zh-CN'),
  sendOnEnter: z.boolean().default(true),
  showReasoningByDefault: z.boolean().default(false),
  sidebarWidth: z
    .number()
    .int()
    .min(PANEL_SIZE_LIMITS.sidebarWidth.min)
    .max(PANEL_SIZE_LIMITS.sidebarWidth.max)
    .default(240),
  rightPanelWidth: z
    .number()
    .int()
    .min(PANEL_SIZE_LIMITS.rightPanelWidth.min)
    .max(PANEL_SIZE_LIMITS.rightPanelWidth.max)
    .default(320),
  bottomPanelHeight: z
    .number()
    .int()
    .min(PANEL_SIZE_LIMITS.bottomPanelHeight.min)
    .max(PANEL_SIZE_LIMITS.bottomPanelHeight.max)
    .default(320),
  /** Window State Persistence: 尺寸、位置、窗口模式与置顶状态。 */
  windowState: windowStateSchema.nullable().default(null),
})
export type AppSettings = z.infer<typeof appSettingsSchema>
