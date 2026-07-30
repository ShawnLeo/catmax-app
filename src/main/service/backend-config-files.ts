/**
 * Backend Config Files: 读写两类配置文件——
 * 1. 后端自己的本地文件（~/.codex/config.toml、~/.claude/settings.json…），原地编辑；
 * 2. catmax 自己拥有的覆盖层（userData/backend-settings/claude-settings.json），
 *    只影响 catmax 内的会话，不碰用户的后端配置目录。
 * 由 descriptor 的 `location` 字段区分（见 shared/backend/config-files.ts）。
 *
 * 安全边界：所有入口只接受 `BACKEND_CONFIG_FILES` 里的稳定 id，路径由本模块查表算出。
 * renderer 永远传不进来一个任意路径——否则这条 IPC 就等价于一个任意文件读写通道。
 *
 * 写盘保证（用户在编辑的是后端赖以启动的真配置，写坏了后端就起不来）：
 * 1. 先按格式校验语法，语法错直接拒写；
 * 2. 检测 mtime 冲突——编辑期间文件被后端/外部工具改过时不闷头覆盖；
 * 3. 覆盖前把旧内容备份到 userData（不往用户的 ~/.codex 里塞 catmax 的文件），保留最近 10 份；
 * 4. 同目录临时文件 + fsync + rename 原子替换，避免半截文件。
 */
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  BACKEND_CONFIG_BACKUP_KEEP,
  BACKEND_CONFIG_FILES,
  getBackendConfigFileDescriptor,
  MAX_BACKEND_CONFIG_BYTES,
  type BackendConfigFileContent,
  type BackendConfigFileDescriptor,
  type BackendConfigFileInfo,
  type BackendConfigFormat,
  type BackendConfigWriteResult,
  type ConfigSyntaxError,
  type ConfigSyntaxResult,
} from '@shared/backend/config-files'
import type { BackendId } from '@shared/constants'
import { app } from 'electron'
import { parse as parseToml, TomlError } from 'smol-toml'

import { logger } from './logger'

const log = logger.domain('backend-config-files')

/** 敏感文件（auth.json）强制 0600；普通配置新建时 0644 */
const SENSITIVE_FILE_MODE = 0o600
const DEFAULT_FILE_MODE = 0o644
/** 新建后端配置目录时用 0700——auth.json 就住在里面 */
const CONFIG_DIR_MODE = 0o700

/**
 * 后端配置目录。两个后端都支持用环境变量改默认位置，这里跟随——
 * 否则用户明明把 codex 指到别处，设置页却在编辑一个 codex 根本不读的文件。
 */
export function resolveBackendConfigDir(backendId: BackendId): string {
  if (backendId === 'codex') {
    const override = process.env.CODEX_HOME?.trim()
    return override ? override : join(homedir(), '.codex')
  }
  if (backendId === 'claude') {
    const override = process.env.CLAUDE_CONFIG_DIR?.trim()
    return override ? override : join(homedir(), '.claude')
  }
  return join(homedir(), `.${backendId}`)
}

/**
 * catmax 自己拥有的后端覆盖配置目录。和 backupRoot() 一样带非 Electron 回退，
 * 好让 vitest 里不 mock electron 也能跑。
 */
export function catmaxBackendConfigDir(): string {
  try {
    return join(app.getPath('userData'), 'backend-settings')
  } catch {
    return join(homedir(), '.catmax', 'backend-settings')
  }
}

export function resolveBackendConfigPath(descriptor: BackendConfigFileDescriptor): string {
  const dir =
    descriptor.location === 'catmax-userdata'
      ? catmaxBackendConfigDir()
      : resolveBackendConfigDir(descriptor.backendId)
  return join(dir, descriptor.relativePath)
}

/**
 * catmax 覆盖配置的绝对路径。不存在时返回 null——
 * 调用方（CladueAdapter）据此决定要不要给 SDK 传 `Options.settings`：
 * 传一个不存在的路径会让 SDK 报错，而"没有覆盖配置"应当等价于"全部走本地配置"。
 */
export function claudeOverrideSettingsPath(): string | null {
  const descriptor = getBackendConfigFileDescriptor('claude.catmaxSettings')
  if (!descriptor) return null
  const path = resolveBackendConfigPath(descriptor)
  try {
    return statSync(path).isFile() ? path : null
  } catch {
    return null
  }
}

/** 备份根目录——放 userData，不污染用户的 ~/.codex / ~/.claude */
function backupRoot(): string {
  try {
    return join(app.getPath('userData'), 'backend-config-backups')
  } catch {
    return join(homedir(), '.catmax', 'backend-config-backups')
  }
}

function requireDescriptor(id: string): BackendConfigFileDescriptor {
  const descriptor = getBackendConfigFileDescriptor(id)
  if (!descriptor) {
    throw new Error(`未知的后端配置文件 id: ${id}`)
  }
  return descriptor
}

function describeConfigFile(descriptor: BackendConfigFileDescriptor): BackendConfigFileInfo {
  const path = resolveBackendConfigPath(descriptor)
  let exists = false
  let size = 0
  let mtimeMs: number | null = null
  try {
    const stat = statSync(path)
    // 目录同名时按"不存在"处理——读写都会失败，不如在 UI 上直接显示未创建
    if (stat.isFile()) {
      exists = true
      size = stat.size
      mtimeMs = stat.mtimeMs
    }
  } catch {
    // ENOENT 等——保持 exists=false
  }
  return {
    id: descriptor.id,
    backendId: descriptor.backendId,
    location: descriptor.location,
    label: descriptor.label,
    description: descriptor.description,
    format: descriptor.format,
    sensitive: descriptor.sensitive,
    docsUrl: descriptor.docsUrl,
    path,
    exists,
    size,
    mtimeMs,
  }
}

export function listBackendConfigFiles(): BackendConfigFileInfo[] {
  return BACKEND_CONFIG_FILES.map(describeConfigFile)
}

/**
 * 从 JSON.parse 的 SyntaxError 里挖出行列。
 * V8 的消息形如 `... in JSON at position 42 (line 3 column 5)`（Node 20+）或只有 position。
 */
function jsonSyntaxError(content: string, error: unknown): ConfigSyntaxError {
  const message = error instanceof Error ? error.message : String(error)
  const lineCol = /line (\d+) column (\d+)/.exec(message)
  if (lineCol) {
    return { ok: false, message, line: Number(lineCol[1]), column: Number(lineCol[2]) }
  }
  const positionMatch = /position (\d+)/.exec(message)
  if (positionMatch) {
    const position = Number(positionMatch[1])
    const before = content.slice(0, position)
    const line = before.split('\n').length
    const column = position - before.lastIndexOf('\n')
    return { ok: false, message, line, column }
  }
  return { ok: false, message, line: null, column: null }
}

/**
 * 保存前的语法校验。只查"能不能被解析"，不校验字段语义——
 * 后端自己的 schema 会演进，catmax 不该替它判断哪个 key 合法。
 */
export function validateConfigSyntax(
  format: BackendConfigFormat,
  content: string,
): ConfigSyntaxResult {
  if (content.trim().length === 0) {
    // 空内容对两种格式含义不同：TOML 空文档 = 空表（合法）；JSON 空文件不是合法 JSON。
    return format === 'toml'
      ? { ok: true }
      : { ok: false, message: '内容不能为空（至少要有一个 {}）', line: 1, column: 1 }
  }

  if (format === 'toml') {
    try {
      parseToml(content)
      return { ok: true }
    } catch (e) {
      if (e instanceof TomlError) {
        return { ok: false, message: e.message, line: e.line, column: e.column }
      }
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
        line: null,
        column: null,
      }
    }
  }

  try {
    const parsed: unknown = JSON.parse(content)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: '顶层必须是一个 JSON 对象', line: 1, column: 1 }
    }
    return { ok: true }
  } catch (e) {
    return jsonSyntaxError(content, e)
  }
}

export function validateBackendConfigContent(id: string, content: string): ConfigSyntaxResult {
  return validateConfigSyntax(requireDescriptor(id).format, content)
}

/**
 * 读取。文件不存在时返回模板（usingTemplate=true），让 UI 直接进"新建"流程而不是空白框。
 * 超过大小上限直接抛——截断显示后再让用户点保存会静默丢数据。
 */
export function readBackendConfigFile(id: string): BackendConfigFileContent {
  const descriptor = requireDescriptor(id)
  const info = describeConfigFile(descriptor)

  if (!info.exists) {
    return { ...info, content: descriptor.template, usingTemplate: true }
  }
  if (info.size > MAX_BACKEND_CONFIG_BYTES) {
    throw new Error(
      `${info.path} 超过 ${Math.round(MAX_BACKEND_CONFIG_BYTES / 1024)}KB，请用外部编辑器修改`,
    )
  }
  return { ...info, content: readFileSync(info.path, 'utf-8'), usingTemplate: false }
}

/** 覆盖前备份旧内容，返回备份路径；备份失败不阻断写入（返回 null 并记日志） */
function backupExisting(
  descriptor: BackendConfigFileDescriptor,
  sourcePath: string,
): string | null {
  try {
    const dir = join(backupRoot(), descriptor.id)
    mkdirSync(dir, { recursive: true, mode: CONFIG_DIR_MODE })
    // 冒号在 Windows 上不是合法文件名字符——ISO 串里的 : 和 . 全换成 -，
    // 换完仍然是定宽的字典序 == 时间序，轮转排序可以直接用文件名。
    // 后缀随机数是防同毫秒内连续两次保存把上一份备份覆盖掉。
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = join(dir, `${stamp}-${randomBytes(2).toString('hex')}.bak`)
    copyFileSync(sourcePath, target)
    if (descriptor.sensitive) chmodSync(target, SENSITIVE_FILE_MODE)
    rotateBackups(dir)
    return target
  } catch (e) {
    log.warn(`backup failed for ${descriptor.id}:`, e)
    return null
  }
}

function rotateBackups(dir: string): void {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.bak'))
    .sort()
  const stale = files.slice(0, Math.max(0, files.length - BACKEND_CONFIG_BACKUP_KEEP))
  for (const name of stale) {
    try {
      unlinkSync(join(dir, name))
    } catch {
      // 删不掉就留着，下次再试——轮转失败不该影响保存
    }
  }
}

/** 目标文件应有的权限位：敏感文件恒定 0600；普通文件沿用已有权限，新建用 0644 */
function targetMode(descriptor: BackendConfigFileDescriptor, path: string): number {
  if (descriptor.sensitive) return SENSITIVE_FILE_MODE
  try {
    return statSync(path).mode & 0o777
  } catch {
    return DEFAULT_FILE_MODE
  }
}

/**
 * 同目录临时文件 + fsync + rename 的原子写。
 * 必须同目录：跨设备 rename 会 EXDEV，而且跨目录 rename 也不再是原子的。
 */
function atomicWrite(path: string, content: string, mode: number): void {
  const tmpPath = join(dirname(path), `.catmax-${randomBytes(6).toString('hex')}.tmp`)
  try {
    const fd = openSync(tmpPath, 'wx', mode)
    try {
      writeSync(fd, content, null, 'utf-8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    // openSync 的 mode 会被 umask 削掉（0600 可能变 0600&~umask），显式再 chmod 一次，
    // 否则 auth.json 的 0600 保证形同虚设。
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

export interface WriteBackendConfigArgs {
  id: string
  content: string
  /**
   * 读到内容时的 mtime（文件当时不存在则为 null）。和当前磁盘状态不一致 = 编辑期间被外部改过。
   */
  expectedMtimeMs: number | null
  /** 用户在冲突提示里选了"仍然覆盖"时为 true，跳过 mtime 检查 */
  force?: boolean
}

export function writeBackendConfigFile(args: WriteBackendConfigArgs): BackendConfigWriteResult {
  const descriptor = requireDescriptor(args.id)

  const syntax = validateConfigSyntax(descriptor.format, args.content)
  if (!syntax.ok) {
    return { ok: false, reason: 'invalid-syntax', syntax }
  }

  if (Buffer.byteLength(args.content, 'utf-8') > MAX_BACKEND_CONFIG_BYTES) {
    return {
      ok: false,
      reason: 'io-error',
      message: `内容超过 ${Math.round(MAX_BACKEND_CONFIG_BYTES / 1024)}KB 上限`,
    }
  }

  const current = describeConfigFile(descriptor)
  if (!args.force && !sameRevision(current, args.expectedMtimeMs)) {
    return { ok: false, reason: 'conflict', info: current }
  }

  try {
    mkdirSync(dirname(current.path), { recursive: true, mode: CONFIG_DIR_MODE })
    const backupPath = current.exists ? backupExisting(descriptor, current.path) : null
    atomicWrite(current.path, args.content, targetMode(descriptor, current.path))
    log.info(`wrote ${descriptor.id} (${current.path})`)
    return { ok: true, info: describeConfigFile(descriptor), backupPath }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log.error(`write failed for ${descriptor.id}:`, e)
    return { ok: false, reason: 'io-error', message }
  }
}

/**
 * 当前磁盘状态是否还是调用方读到的那一版。
 * 文件从"不存在"变成"存在"（比如用户同时跑了 codex login）也算冲突。
 */
function sameRevision(current: BackendConfigFileInfo, expectedMtimeMs: number | null): boolean {
  if (!current.exists) return expectedMtimeMs === null
  if (expectedMtimeMs === null) return false
  // 不同文件系统的 mtime 精度不同（HFS+ 只到秒），比较到毫秒取整即可
  return Math.round(current.mtimeMs ?? 0) === Math.round(expectedMtimeMs)
}
