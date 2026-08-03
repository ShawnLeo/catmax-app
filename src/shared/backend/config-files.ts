/**
 * Backend Config Files: 后端自己的本地配置文件（~/.codex/config.toml 等）的描述表 + 读写契约类型。
 *
 * 设计要点（和 cc-switch 那类"供应商切换器"的区别）：
 * - catmax **不保存**后端本地文件（`location: 'backend-home'`）的副本，更不保存其中的密钥。
 *   设置页对这些文件只是一个"直接编辑活动文件"的编辑器：读 → 校验语法 → 备份 → 原子写回。
 *   这是有意为之——本 app 至今不持久化任何凭证（没有 credential IPC domain），引入
 *   provider profile 会推翻这条设计。
 * - 唯一例外是 `location: 'catmax-userdata'` 的覆盖层（claude.catmaxSettings）：这份文件由
 *   catmax 自己拥有、住在 userData 里，编辑它**不会**碰用户的 ~/.claude。它通过 Claude Agent
 *   SDK 的 `Options.settings` 注入到 'flag' 层——优先级 managed > flag > user > project > local，
 *   **文件里没写的 key 自动回落到用户本地配置**。所以"应用里没配就走本地、配了就覆盖本地"
 *   是 SDK 原生语义，catmax 不需要自己做合并。
 *   ⚠️ 两个注意点（实测 resolveSettings 得到）：`env` 是逐 key 深合并（只设一个变量不会抹掉
 *   用户的其他变量）；但 `permissions.allow`/`deny` 是**数组取并集**，这一层只能加权限、
 *   减不了——要收紧只能走 SDK 的 `managedSettings`（restrictive-only）。
 * - renderer 只能按这里的稳定 id 请求读写，**绝不接受任意路径**——否则这条 IPC 就成了
 *   一个任意文件读写通道。路径解析全部在主进程按 id 查表完成（见 main/service/backend-config-files.ts）。
 */
import type { BackendId } from '../constants'

/** 配置文件语法格式——决定保存前用哪个 parser 校验 */
export type BackendConfigFormat = 'toml' | 'json'

/** 稳定 id：IPC 上唯一的"我要读写哪个文件"的表达方式 */
export type BackendConfigFileId =
  'codex.config' | 'codex.auth' | 'claude.settings' | 'claude.catmaxSettings'

/**
 * 文件住在哪 —— 同时决定路径解析和影响范围，UI 必须把这个区分显示出来：
 * 两种 tab 都能设 model/env/permissions，用户得知道自己改的是
 * "连命令行 claude 一起改了"还是"只影响 catmax"。
 *
 * - `backend-home`：后端自己的配置目录（~/.claude、~/.codex，跟随 CLAUDE_CONFIG_DIR /
 *   CODEX_HOME）。catmax 原地改用户的真文件。
 * - `catmax-userdata`：catmax 自己的 userData 目录。用户的后端配置目录完全不受影响。
 */
export type BackendConfigLocation = 'backend-home' | 'catmax-userdata'

export interface BackendConfigFileDescriptor {
  id: BackendConfigFileId
  backendId: BackendId
  location: BackendConfigLocation
  /** 相对所属目录（见 location）的路径。必须是纯文件名或不含 `..` 的相对路径。 */
  relativePath: string
  /** UI 上的短标题，例如 "config.toml" */
  label: string
  /** UI 上的一句话说明——告诉用户这个文件管什么 */
  description: string
  format: BackendConfigFormat
  /**
   * 含明文密钥。UI 默认遮罩内容需显式点开，写盘强制 0600。
   */
  sensitive: boolean
  /** 文件不存在时编辑器里预填的模板（不会自动写盘，用户按保存才落地） */
  template: string
  /** 官方文档地址，UI 上给个"查看文档"链接 */
  docsUrl: string
}

const CODEX_CONFIG_TEMPLATE = `# Codex 配置文件（TOML）。完整字段见官方 config 文档。
# 常用项：
# model = "gpt-5-codex"
# model_reasoning_effort = "medium"
# approval_policy = "on-request"

# 自定义 model provider（走第三方中转时用）：
# [model_providers.custom]
# name = "custom"
# base_url = "https://example.com/v1"
# env_key = "CUSTOM_API_KEY"
`

const CODEX_AUTH_TEMPLATE = `{
  "OPENAI_API_KEY": ""
}
`

const CLAUDE_SETTINGS_TEMPLATE = `{
  "env": {},
  "permissions": {
    "allow": [],
    "deny": []
  }
}
`

/**
 * catmax 覆盖层的模板。故意只给一个空 env 起手——
 * 这一层的语义是"写了的 key 覆盖本地、没写的 key 回落本地"，
 * 所以预填一堆空字段只会让人误以为空数组能"清空"本地权限（实际是取并集）。
 */
const CLAUDE_CATMAX_SETTINGS_TEMPLATE = `{
  "env": {}
}
`

/**
 * Internal Beta Login: 内测版登录时写入 Claude 覆盖文件的默认配置里的密钥占位符。
 * AuthStore.login 会把真实密钥 replace 进 CLAUDE_INTERNAL_DEFAULT_OVERRIDE。
 */
export const ANTHROPIC_AUTH_TOKEN_PLACEHOLDER = '$ANTHROPIC_AUTH_TOKEN'

/**
 * Internal Beta Login: 内测版登录时强制写入 Claude 覆盖文件的默认配置。
 *
 * 落在 `claude.catmaxSettings`（<userData>/backend-settings/claude-settings.json）——
 * SDK 的 'flag' 层，env 走逐 key 深合并，不会抹掉用户 ~/.claude/settings.json 的其他 env。
 *
 * 字段含义：
 * - claude.dangerouslySkipPermissions: 跳过所有权限确认（内测体验，已知风险）
 * - effortLevel: high
 * - env.ANTHROPIC_AUTH_TOKEN: 占位符，登录时替换成用户输入的密钥（明文，0600 保护）
 * - env.ANTHROPIC_BASE_URL / *_MODEL / API_TIMEOUT_MS / CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
 *   指向内测中转与模型映射
 * - includeCoAuthoredBy: false
 */
export const CLAUDE_INTERNAL_DEFAULT_OVERRIDE = `{
  "claude.dangerouslySkipPermissions": true,
  "effortLevel": "high",
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "${ANTHROPIC_AUTH_TOKEN_PLACEHOLDER}",
    "ANTHROPIC_BASE_URL": "https://www.catmax.cn",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-4.7",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.2",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.2",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": 1
  },
  "includeCoAuthoredBy": false
}`

/**
 * 可在设置页编辑的后端配置文件白名单。
 * 顺序即 UI 上的 tab 顺序。
 */
export const BACKEND_CONFIG_FILES: readonly BackendConfigFileDescriptor[] = [
  {
    id: 'claude.catmaxSettings',
    backendId: 'claude',
    location: 'catmax-userdata',
    relativePath: 'claude-settings.json',
    label: 'catmax 覆盖配置',
    description:
      '只影响 catmax 内的会话，不会写入 ~/.claude。这里写了的 key 覆盖本地配置，没写的 key 回落到本地配置——删掉一个 key 就等于"这项交还给本地"。注意 permissions 数组是和本地取并集，这一层只能加权限、减不了。',
    format: 'json',
    // env 块常被用来放 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL，按敏感文件对待：
    // 写盘强制 0600，UI 默认遮罩。
    sensitive: true,
    template: CLAUDE_CATMAX_SETTINGS_TEMPLATE,
    docsUrl: 'https://docs.claude.com/en/docs/claude-code/settings',
  },
  {
    id: 'claude.settings',
    backendId: 'claude',
    location: 'backend-home',
    relativePath: 'settings.json',
    label: 'settings.json',
    description:
      '用户的全局设置，原地编辑：env（含 ANTHROPIC_BASE_URL 等）、permissions、hooks、model。改这里连命令行 claude 也一起生效。',
    format: 'json',
    sensitive: false,
    template: CLAUDE_SETTINGS_TEMPLATE,
    docsUrl: 'https://docs.claude.com/en/docs/claude-code/settings',
  },
  {
    id: 'codex.config',
    backendId: 'codex',
    location: 'backend-home',
    relativePath: 'config.toml',
    label: 'config.toml',
    description: '全局设置：model、model_provider、approval_policy、sandbox、MCP server。',
    format: 'toml',
    sensitive: false,
    template: CODEX_CONFIG_TEMPLATE,
    docsUrl: 'https://github.com/openai/codex/blob/main/docs/config.md',
  },
  {
    id: 'codex.auth',
    backendId: 'codex',
    location: 'backend-home',
    relativePath: 'auth.json',
    label: 'auth.json',
    description: '凭证文件：API key / OAuth token。改坏会导致 codex 需要重新登录。',
    format: 'json',
    sensitive: true,
    template: CODEX_AUTH_TEMPLATE,
    docsUrl: 'https://github.com/openai/codex/blob/main/docs/authentication.md',
  },
] as const

export function getBackendConfigFileDescriptor(
  id: string,
): BackendConfigFileDescriptor | undefined {
  return BACKEND_CONFIG_FILES.find((d) => d.id === id)
}

export function backendConfigFilesFor(backendId: BackendId): BackendConfigFileDescriptor[] {
  return BACKEND_CONFIG_FILES.filter((d) => d.backendId === backendId)
}

/**
 * 单个配置文件能编辑的上限。超过就拒绝读——把超大文件截断显示、再让用户"保存"会直接丢数据。
 */
export const MAX_BACKEND_CONFIG_BYTES = 512 * 1024

/** 保留的备份份数（超过按时间从旧到新淘汰） */
export const BACKEND_CONFIG_BACKUP_KEEP = 10

/** 文件元信息——不含内容，用于列表展示 */
export interface BackendConfigFileInfo {
  id: BackendConfigFileId
  backendId: BackendId
  location: BackendConfigLocation
  label: string
  description: string
  format: BackendConfigFormat
  sensitive: boolean
  docsUrl: string
  /** 主进程解析出的绝对路径（renderer 只做展示，不能用它反向请求读写） */
  path: string
  exists: boolean
  /** 不存在时为 0 */
  size: number
  /** 不存在时为 null。写回时原样带上，用于检测"编辑期间文件被外部改过" */
  mtimeMs: number | null
}

export interface BackendConfigFileContent extends BackendConfigFileInfo {
  /** 文件不存在时这里是 template */
  content: string
  /** true 表示 content 是模板而非磁盘内容 */
  usingTemplate: boolean
}

export interface ConfigSyntaxOk {
  ok: true
}

export interface ConfigSyntaxError {
  ok: false
  message: string
  /** 1-based；parser 没给出位置时为 null */
  line: number | null
  column: number | null
}

export type ConfigSyntaxResult = ConfigSyntaxOk | ConfigSyntaxError

/**
 * 写回结果。失败分三种，UI 对每种给不同出口：
 * - invalid-syntax：定位到行列，不写盘
 * - conflict：文件被外部改过，给"重新加载"/"强制覆盖"
 * - io-error：权限、磁盘等
 */
export type BackendConfigWriteResult =
  | { ok: true; info: BackendConfigFileInfo; backupPath: string | null }
  | { ok: false; reason: 'invalid-syntax'; syntax: ConfigSyntaxError }
  | { ok: false; reason: 'conflict'; info: BackendConfigFileInfo }
  | { ok: false; reason: 'io-error'; message: string }
