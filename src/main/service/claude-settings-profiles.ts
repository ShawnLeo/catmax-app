/**
 * Claude Settings Profiles: catmax 覆盖配置（`claude.catmaxSettings`）的多档存储。
 *
 * 目录布局（全部在 catmax 自己的 userData 下，绝不碰用户的 ~/.claude）：
 *
 *   <userData>/backend-settings/
 *     claude-settings.json.migrated   ← 单档时代的旧文件，迁移后改名保留（不再被读）
 *     claude-profiles/
 *       index.json                    ← 元数据 + 当前档（真相源）
 *       <uuid>.json                   ← 每档一份完整的覆盖配置内容（0600）
 *
 * **index.json 是真相源**：目录里的孤儿 .json 不会被自动收编。理由是"档已登记但文件还没落盘"
 * 是合法状态（新建后没保存过，编辑器显示模板），没法靠扫目录区分孤儿和未落盘的档。
 *
 * 为什么元数据不进 settings.json（和协议桥的 provider 相反）：
 * 见 shared/backend/claude-settings-profiles.ts 顶部注释——一份档就是一整份含明文密钥的
 * JSON 文件，settings.json 是 0644 且 renderer 能整份读走。
 *
 * 不做内存缓存：index.json 只有几百字节，每次同步读一遍，省掉一整类缓存失效 bug。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

import {
  CLAUDE_SETTINGS_PROFILE_NAME_MAX,
  INTERNAL_BETA_PROFILE_ID,
  INTERNAL_BETA_PROFILE_NAME,
  MAX_CLAUDE_SETTINGS_PROFILES,
  NO_CLAUDE_SETTINGS_PROFILE,
  normalizeProfileName,
  type ClaudeSettingsProfileInfo,
  type ClaudeSettingsProfilesSnapshot,
} from '@shared/backend/claude-settings-profiles'

import { catmaxBackendConfigDir } from './backend-config-paths'
import { logger } from './logger'

const log = logger.domain('claude-settings-profiles')

/** 档内容含明文密钥（env.ANTHROPIC_AUTH_TOKEN），和单档时代一样强制 0600 */
const FILE_MODE = 0o600
const DIR_MODE = 0o700

/** 单档时代的文件名。迁移时读它、迁移后加这个后缀改名保留。 */
const LEGACY_FILE = 'claude-settings.json'
const LEGACY_MIGRATED_SUFFIX = '.migrated'

/**
 * 未选中任何档时 `resolveBackendConfigPath` 返回的占位文件名。
 *
 * 下划线前缀保证永远撞不上 uuid 档名。这个文件永远不会被创建——
 * 无当前档时 write 被直接拒绝（见 backend-config-files.ts），
 * 注入侧也在查到空 currentId 时就返回 null，压根不会 stat 它。
 * 存在的唯一意义是让 `listConfigFiles()` 有个路径可回，不必为这一条特判出一个可空字段。
 */
const NO_PROFILE_PLACEHOLDER = '_none.json'

export function claudeProfilesDir(): string {
  return join(catmaxBackendConfigDir(), 'claude-profiles')
}

function indexPath(): string {
  return join(claudeProfilesDir(), 'index.json')
}

function legacyPath(): string {
  return join(catmaxBackendConfigDir(), LEGACY_FILE)
}

/** 落盘结构。只有元数据，档内容各自在 `<id>.json` 里。 */
interface ProfilesIndex {
  currentId: string
  profiles: { id: string; name: string; createdAt: number; managed: boolean }[]
}

/**
 * 必须是工厂函数，不能是共享常量：调用方会往返回值的 `profiles` 里 push，
 * 而 `{ ...CONST }` 只是浅拷贝——数组还是同一个引用，一次 push 就把"空索引"
 * 这个常量永久污染了，之后每次读盘失败都会凭空多出上一次的档。
 */
function emptyIndex(): ProfilesIndex {
  return { currentId: NO_CLAUDE_SETTINGS_PROFILE, profiles: [] }
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

/**
 * 同目录临时文件 + fsync + rename 的原子写。
 * 必须同目录：跨设备 rename 会 EXDEV，跨目录 rename 也不再是原子的。
 */
function atomicWrite(path: string, content: string, mode: number): void {
  mkdirSync(claudeProfilesDir(), { recursive: true, mode: DIR_MODE })
  const tmpPath = join(claudeProfilesDir(), `.catmax-${randomBytes(6).toString('hex')}.tmp`)
  try {
    const fd = openSync(tmpPath, 'wx', mode)
    try {
      writeSync(fd, content, null, 'utf-8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    // openSync 的 mode 会被 umask 削掉，显式再 chmod 一次，否则 0600 保证形同虚设
    chmodSync(tmpPath, mode)
    renameSync(tmpPath, path)
  } catch (e) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
    } catch {
      // 清理失败不掩盖原始错误
    }
    throw e
  }
}

function writeIndex(index: ProfilesIndex): void {
  atomicWrite(indexPath(), `${JSON.stringify(index, null, 2)}\n`, FILE_MODE)
}

/** 校验并规整从磁盘读到的 index——外部编辑坏了应当退化成"没有档"，而不是让设置页崩掉 */
function sanitizeIndex(raw: unknown): ProfilesIndex {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptyIndex()
  const source = raw as Partial<ProfilesIndex>
  const seen = new Set<string>()
  const profiles: ProfilesIndex['profiles'] = []
  for (const entry of Array.isArray(source.profiles) ? source.profiles : []) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    // 档 id 直接参与文件名拼接，必须挡住路径分隔符和 `..`
    if (id.length === 0 || seen.has(id) || !/^[A-Za-z0-9_-]+$/.test(id)) continue
    seen.add(id)
    profiles.push({
      id,
      name: normalizeProfileName(typeof entry.name === 'string' ? entry.name : ''),
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
      managed: entry.managed === true,
    })
  }
  profiles.sort((a, b) => a.createdAt - b.createdAt)
  const currentId = typeof source.currentId === 'string' ? source.currentId : ''
  return {
    currentId: seen.has(currentId) ? currentId : NO_CLAUDE_SETTINGS_PROFILE,
    profiles,
  }
}

// ---------------------------------------------------------------------------
// 迁移：单档 → 多档
// ---------------------------------------------------------------------------

/**
 * 把单档时代的 `claude-settings.json` 收编成第一档。
 *
 * 只在 index.json 还不存在时跑一次，之后永远走不到这里。
 * 旧文件是**改名**保留（`.migrated` 后缀）而不是删除：万一迁移中途出错或用户回退版本，
 * 内容还在磁盘上；同时改了名就不会有"两个文件都像是生效配置"的困惑。
 */
function migrateLegacy(): ProfilesIndex {
  const legacy = legacyPath()
  let legacyIsFile = false
  try {
    legacyIsFile = statSync(legacy).isFile()
  } catch {
    // 不存在——全新用户，没有可迁移的东西
  }

  if (!legacyIsFile) {
    const empty = emptyIndex()
    writeIndex(empty)
    return empty
  }

  const id = randomUUID()
  const index: ProfilesIndex = {
    currentId: id,
    profiles: [{ id, name: '默认配置', createdAt: Date.now(), managed: false }],
  }
  try {
    mkdirSync(claudeProfilesDir(), { recursive: true, mode: DIR_MODE })
    copyFileSync(legacy, profileFilePath(id))
    chmodSync(profileFilePath(id), FILE_MODE)
    writeIndex(index)
    renameSync(legacy, `${legacy}${LEGACY_MIGRATED_SUFFIX}`)
    log.info(`migrated legacy claude override settings into profile ${id}`)
    return index
  } catch (e) {
    // 迁移失败不能让整个设置页起不来：退回"没有档"，旧文件原封不动留在原处
    log.error('legacy claude override settings migration failed:', e)
    return emptyIndex()
  }
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

function loadIndex(): ProfilesIndex {
  const path = indexPath()
  if (!existsSync(path)) return migrateLegacy()
  try {
    return sanitizeIndex(JSON.parse(readFileSync(path, 'utf-8')))
  } catch (e) {
    log.warn('claude profiles index unreadable, treating as empty:', e)
    return emptyIndex()
  }
}

export function profileFilePath(id: string): string {
  return join(claudeProfilesDir(), `${id}.json`)
}

/**
 * 当前生效档的文件路径。
 *
 * 返回 null 表示"用户显式选择了不启用覆盖"——调用方（adapter）据此完全不给 SDK 传
 * `Options.settings`，等价于全部走用户本地 ~/.claude。
 */
export function currentClaudeProfilePath(): string | null {
  const index = loadIndex()
  if (index.currentId === NO_CLAUDE_SETTINGS_PROFILE) return null
  return profileFilePath(index.currentId)
}

/** 供 `resolveBackendConfigPath` 用：无当前档时给一个恒不存在的占位路径（见常量注释） */
export function currentClaudeProfilePathOrPlaceholder(): string {
  return currentClaudeProfilePath() ?? join(claudeProfilesDir(), NO_PROFILE_PLACEHOLDER)
}

export function hasCurrentClaudeProfile(): boolean {
  return loadIndex().currentId !== NO_CLAUDE_SETTINGS_PROFILE
}

function describeProfile(entry: ProfilesIndex['profiles'][number]): ClaudeSettingsProfileInfo {
  const path = profileFilePath(entry.id)
  let exists = false
  let size = 0
  let mtimeMs: number | null = null
  try {
    const stat = statSync(path)
    if (stat.isFile()) {
      exists = true
      size = stat.size
      mtimeMs = stat.mtimeMs
    }
  } catch {
    // 档已登记但还没保存过——保持 exists=false，编辑器会显示模板
  }
  return { ...entry, path, exists, size, mtimeMs }
}

export function listClaudeSettingsProfiles(): ClaudeSettingsProfilesSnapshot {
  const index = loadIndex()
  return { currentId: index.currentId, profiles: index.profiles.map(describeProfile) }
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

export interface CreateClaudeProfileArgs {
  name: string
  /** 从这一档复制内容起手（"另存为"）。源档不存在或没落盘时静默建空档。 */
  copyFromId?: string
}

/**
 * 新建一档并**切过去**（和协议桥的"新建即选中"一致）。
 * 不复制时不建文件——档处于"未落盘"状态，编辑器直接显示模板，用户按保存才落地。
 */
export function createClaudeSettingsProfile(
  args: CreateClaudeProfileArgs,
): ClaudeSettingsProfilesSnapshot {
  const index = loadIndex()
  if (index.profiles.length >= MAX_CLAUDE_SETTINGS_PROFILES) {
    throw new Error(`最多只能保存 ${MAX_CLAUDE_SETTINGS_PROFILES} 份配置`)
  }
  const id = randomUUID()
  mkdirSync(claudeProfilesDir(), { recursive: true, mode: DIR_MODE })

  if (args.copyFromId) {
    const source = profileFilePath(args.copyFromId)
    try {
      if (statSync(source).isFile()) {
        copyFileSync(source, profileFilePath(id))
        chmodSync(profileFilePath(id), FILE_MODE)
      }
    } catch (e) {
      log.warn(`copy from profile ${args.copyFromId} failed, creating empty profile:`, e)
    }
  }

  index.profiles.push({
    id,
    name: normalizeProfileName(args.name),
    createdAt: Date.now(),
    managed: false,
  })
  index.currentId = id
  writeIndex(index)
  return listClaudeSettingsProfiles()
}

export function renameClaudeSettingsProfile(args: {
  id: string
  name: string
}): ClaudeSettingsProfilesSnapshot {
  const index = loadIndex()
  const entry = index.profiles.find((p) => p.id === args.id)
  if (!entry) throw new Error(`未知的配置档: ${args.id}`)
  // managed 档的名字和登录态绑定，改了名用户就分不清它会被登录流程重写
  if (entry.managed) throw new Error('内置配置不支持改名')
  if (args.name.trim().length > CLAUDE_SETTINGS_PROFILE_NAME_MAX) {
    throw new Error(`名称最多 ${CLAUDE_SETTINGS_PROFILE_NAME_MAX} 个字符`)
  }
  entry.name = normalizeProfileName(args.name)
  writeIndex(index)
  return listClaudeSettingsProfiles()
}

/**
 * 删档 + 删文件。
 *
 * 删掉的正好是当前档时，回落到剩下的第一档（按 createdAt），一档不剩才回落到"不启用"。
 * 不直接回落到"不启用"是因为那会让 claude 突然完全走本地配置——用户手上还有别的档时，
 * 静默变成"没有任何覆盖"比换到相邻一档更容易让人措手不及。UI 上当前档名一直可见。
 */
export function deleteClaudeSettingsProfile(args: { id: string }): ClaudeSettingsProfilesSnapshot {
  const index = loadIndex()
  const entry = index.profiles.find((p) => p.id === args.id)
  if (!entry) throw new Error(`未知的配置档: ${args.id}`)
  if (entry.managed) throw new Error('内置配置由登录状态管理，请通过退出登录来清除')

  index.profiles = index.profiles.filter((p) => p.id !== args.id)
  if (index.currentId === args.id) {
    index.currentId = index.profiles[0]?.id ?? NO_CLAUDE_SETTINGS_PROFILE
  }
  writeIndex(index)
  removeProfileFile(args.id)
  return listClaudeSettingsProfiles()
}

/** 先写 index 再删文件：反过来的话删文件成功、写 index 失败会留下一个指向空档的条目 */
function removeProfileFile(id: string): void {
  try {
    const path = profileFilePath(id)
    if (existsSync(path)) unlinkSync(path)
  } catch (e) {
    log.warn(`delete profile file ${id} failed, content may remain on disk:`, e)
  }
}

/** 切换当前档。`id` 传 `NO_CLAUDE_SETTINGS_PROFILE` 表示不启用任何覆盖。 */
export function selectClaudeSettingsProfile(args: { id: string }): ClaudeSettingsProfilesSnapshot {
  const index = loadIndex()
  if (args.id !== NO_CLAUDE_SETTINGS_PROFILE && !index.profiles.some((p) => p.id === args.id)) {
    throw new Error(`未知的配置档: ${args.id}`)
  }
  index.currentId = args.id
  writeIndex(index)
  return listClaudeSettingsProfiles()
}

// ---------------------------------------------------------------------------
// Internal Beta Login
// ---------------------------------------------------------------------------

/**
 * 确保内测登录档存在并切过去，供 auth-store 在写默认覆盖配置前调用。
 *
 * 单开一档的意义：登录写的是 `force: true` 的整份覆盖，落在用户手写的档上就是把人家
 * 的配置冲掉。多档之后登录只影响这一档，用户自己的档原封不动，登出时也能连档带文件删干净。
 */
export function ensureInternalBetaProfile(): void {
  const index = loadIndex()
  if (!index.profiles.some((p) => p.id === INTERNAL_BETA_PROFILE_ID)) {
    index.profiles.push({
      id: INTERNAL_BETA_PROFILE_ID,
      name: INTERNAL_BETA_PROFILE_NAME,
      createdAt: Date.now(),
      managed: true,
    })
  }
  index.currentId = INTERNAL_BETA_PROFILE_ID
  writeIndex(index)
}

/** 退出登录：连档带文件删掉，当前档回落到剩下的第一档（一档不剩则不启用覆盖）。 */
export function removeInternalBetaProfile(): void {
  const index = loadIndex()
  if (!index.profiles.some((p) => p.id === INTERNAL_BETA_PROFILE_ID)) return
  index.profiles = index.profiles.filter((p) => p.id !== INTERNAL_BETA_PROFILE_ID)
  if (index.currentId === INTERNAL_BETA_PROFILE_ID) {
    index.currentId = index.profiles[0]?.id ?? NO_CLAUDE_SETTINGS_PROFILE
  }
  writeIndex(index)
  removeProfileFile(INTERNAL_BETA_PROFILE_ID)
}
