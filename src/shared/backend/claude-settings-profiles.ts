/**
 * Claude Settings Profiles: catmax 覆盖配置（`claude.catmaxSettings`）的多档管理。
 *
 * 解决的问题：覆盖层原先是**一个**固定文件，换一套上游/密钥就得把上一套抹掉重写。
 * 多档之后每套配置各占一个文件，切换只改「当前档」，别的档一个字节都不动——
 * 和协议桥的多 provider 是同一个心智模型。
 *
 * 与协议桥 provider 的**存储方式差异**（不要照抄桥的做法）：
 * - 桥的 provider 是结构化字段且不含密钥，所以整份存进 settings.json，密钥另存 0600 文件。
 * - 这里一份档就是**一整份任意 JSON 文件内容**，且 env 块里常放 ANTHROPIC_AUTH_TOKEN
 *   （descriptor 标了 `sensitive`，写盘强制 0600）。settings.json 是 0644、会被备份/同步、
 *   renderer 能整份读走——把档内容放进去等于把密钥挪到一个更宽松的文件里。
 * 所以：**内容留在各自的 0600 文件里，settings.json 一个字节都不碰**，
 * 元数据（id/name/createdAt）单独存在档目录的 index.json 里。
 *
 * 真相源是 index.json：目录里的孤儿 .json 文件不会被自动收编（见 main/service/claude-settings-profiles.ts）。
 */

/**
 * 「不启用任何覆盖」的哨兵值。
 *
 * 必须保留这个状态：原先"覆盖文件不存在 == 完全走用户本地 ~/.claude"是既有语义，
 * 多档之后如果强制必须选中某一档，用户就再也回不到"catmax 不做任何覆盖"了。
 */
export const NO_CLAUDE_SETTINGS_PROFILE = ''

/**
 * Internal Beta Login: 内测登录自动写入的那一档，用固定 id。
 *
 * 单独一档而不是覆盖用户的当前档——登录写的是 `force: true` 的整份覆盖，
 * 落在用户手写的档上就是把人家的配置冲没了。登出时连档带文件一起删。
 */
export const INTERNAL_BETA_PROFILE_ID = 'catmax-internal-beta'
export const INTERNAL_BETA_PROFILE_NAME = 'catmax 内测'

/** 档数上限——防止 UI 列表和档目录被脚本刷爆；正常用户几档就够 */
export const MAX_CLAUDE_SETTINGS_PROFILES = 30

/** 档名长度上限（字符数）。空名字由主进程回落成「未命名配置」 */
export const CLAUDE_SETTINGS_PROFILE_NAME_MAX = 40

export interface ClaudeSettingsProfileInfo {
  id: string
  name: string
  /** 毫秒时间戳，列表按它升序 */
  createdAt: number
  /**
   * catmax 自动维护的档（目前只有内测登录档）。
   * 内容仍可编辑（用户可能要临时改个 model），但不允许改名/删除——
   * 那两个操作会让登录态和档对不上，登出时也就清不干净密钥了。
   */
  managed: boolean
  /** 主进程解析出的绝对路径，renderer 只做展示 */
  path: string
  /** 档已登记但文件还没落盘（新建后没保存过）时为 false */
  exists: boolean
  size: number
  mtimeMs: number | null
}

export interface ClaudeSettingsProfilesSnapshot {
  /** 当前生效的档 id；`NO_CLAUDE_SETTINGS_PROFILE` 表示不启用覆盖 */
  currentId: string
  /** 按 createdAt 升序 */
  profiles: ClaudeSettingsProfileInfo[]
}

/** 把用户输入的档名规整成可存的形式（截断 + 去首尾空白 + 空名回落） */
export function normalizeProfileName(raw: string): string {
  const trimmed = raw.trim().slice(0, CLAUDE_SETTINGS_PROFILE_NAME_MAX)
  return trimmed.length > 0 ? trimmed : '未命名配置'
}
