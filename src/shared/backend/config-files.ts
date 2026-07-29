/**
 * Backend Config Files: 后端自己的本地配置文件（~/.codex/config.toml 等）的描述表 + 读写契约类型。
 *
 * 设计要点（和 cc-switch 那类"供应商切换器"的区别）：
 * - catmax **不保存**这些文件的副本，更不保存其中的密钥。设置页只是一个"直接编辑活动文件"
 *   的编辑器：读 → 校验语法 → 备份 → 原子写回。这是有意为之——本 app 至今不持久化任何凭证
 *   （没有 credential IPC domain），引入 provider profile 会推翻这条设计。
 * - renderer 只能按这里的稳定 id 请求读写，**绝不接受任意路径**——否则这条 IPC 就成了
 *   一个任意文件读写通道。路径解析全部在主进程按 id 查表完成（见 main/service/backend-config-files.ts）。
 */
import type { BackendId } from '../constants'

/** 配置文件语法格式——决定保存前用哪个 parser 校验 */
export type BackendConfigFormat = 'toml' | 'json'

/** 稳定 id：IPC 上唯一的"我要读写哪个文件"的表达方式 */
export type BackendConfigFileId = 'codex.config' | 'codex.auth' | 'claude.settings'

export interface BackendConfigFileDescriptor {
  id: BackendConfigFileId
  backendId: BackendId
  /** 相对该后端配置目录的路径。必须是纯文件名或不含 `..` 的相对路径。 */
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
 * 可在设置页编辑的后端配置文件白名单。
 * 顺序即 UI 上的 tab 顺序。
 */
export const BACKEND_CONFIG_FILES: readonly BackendConfigFileDescriptor[] = [
  {
    id: 'claude.settings',
    backendId: 'claude',
    relativePath: 'settings.json',
    label: 'settings.json',
    description: '全局设置：env（含 ANTHROPIC_BASE_URL 等）、permissions、hooks、model。',
    format: 'json',
    sensitive: false,
    template: CLAUDE_SETTINGS_TEMPLATE,
    docsUrl: 'https://docs.claude.com/en/docs/claude-code/settings',
  },
  {
    id: 'codex.config',
    backendId: 'codex',
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
