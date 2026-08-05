/**
 * 内测登录态持久化存储。
 *
 * ⚠️ 与 bridge-credentials.ts 同样的安全约定：**不进 settings.json**。
 * settings.json 是 0644、会被备份/同步、renderer 能整份读走。登录态单独存
 * 一个文件（auth.json，0600），只保留「是否登录 / 登录方式」元信息。
 *
 * Internal Beta Login 职责分层（关键：settings 的真相源在 renderer）——
 * main 负责（renderer 碰不到的东西）：
 *   1. 登录态落盘 auth.json（0600）
 *   2. 写 Claude 覆盖文件 claude.catmaxSettings（含明文密钥，0600）
 *   3. 存桥密钥到 bridge-credentials.json（0600）
 *   4. login 返回值带回内测桥 provider 元数据，让 renderer 写 settings
 * renderer 负责（settings 单一 IPC 链路，UI 自动刷新）：
 *   1. login 后调 settings.update 写 protocolBridge（启用桥 + provider）
 *   2. logout 后调 settings.update 清 protocolBridge
 * 这样避免 main 绕过 IPC 直改 settingsStore 导致 renderer store/UI 不刷新。
 *
 * 重启 app 后通过 getStatus() 恢复登录态，实现"记住登录"。
 */
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import {
  ANTHROPIC_AUTH_TOKEN_PLACEHOLDER,
  CLAUDE_INTERNAL_DEFAULT_OVERRIDE,
} from '@shared/backend/config-files'
import type { AuthStatus, LoginMethod } from '@shared/ipc/auth'
import {
  INTERNAL_BETA_PROVIDER_ID,
  createInternalBetaProvider,
} from '@shared/protocol/bridge-config'
import { app } from 'electron'

import { writeBackendConfigFile } from './backend-config-files'
import { clearStoredCredential, setStoredCredential } from './bridge-credentials'
import { ensureInternalBetaProfile, removeInternalBetaProfile } from './claude-settings-profiles'
import { logger } from './logger'

const log = logger.domain('auth-store')

const FILE_MODE = 0o600
const DIR_MODE = 0o700

/** auth.json 落盘结构：只保留登录态元信息（密钥本身不进这里）。 */
interface AuthFile {
  loggedIn: boolean
  loginMethod: LoginMethod | null
}

const DEFAULT_STATE: AuthFile = { loggedIn: false, loginMethod: null }

function authFilePath(): string {
  // app.getPath 在测试环境不可用，退回临时目录，避免测试往真实 userData 写东西
  let base: string
  try {
    base = app.getPath('userData')
  } catch {
    base = join(process.env.TMPDIR ?? '/tmp', 'catmax-test-userdata')
  }
  return join(base, 'auth.json')
}

function readFile(): AuthFile {
  const path = authFilePath()
  if (!existsSync(path)) return { ...DEFAULT_STATE }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_STATE }
    const obj = parsed as Partial<AuthFile>
    return {
      loggedIn: obj.loggedIn === true,
      // 只接受已知的登录方式，未知值一律视为未登录
      loginMethod: obj.loginMethod === 'secret-key' ? 'secret-key' : null,
    }
  } catch (error) {
    log.warn('登录态文件损坏，按未登录处理', error instanceof Error ? error.message : String(error))
    return { ...DEFAULT_STATE }
  }
}

/** 同目录临时文件 + fsync + rename 原子替换，并显式 chmod（openSync 的 mode 会被 umask 削） */
function writeFile(state: AuthFile): void {
  const path = authFilePath()
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
  const tmpPath = join(dirname(path), `.auth-${randomBytes(6).toString('hex')}.tmp`)
  try {
    const fd = openSync(tmpPath, 'wx', FILE_MODE)
    try {
      writeSync(fd, JSON.stringify(state), null, 'utf-8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(tmpPath, FILE_MODE)
    renameSync(tmpPath, path)
  } catch (error) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw error
  }
}

/**
 * 主进程登录态单例。Context 持有唯一实例，IPC handler 通过它读写。
 * 内存缓存避免每次 IPC 都读盘；写操作同步落盘以保证重启后恢复。
 */
export class AuthStore {
  private cache: AuthFile | null = null

  /** 读取当前登录态（首次读盘，后续命中缓存）。 */
  getStatus(): AuthStatus {
    const state = this.cache ?? readFile()
    this.cache = state
    return { loggedIn: state.loggedIn, loginMethod: state.loginMethod }
  }

  /**
   * 标记为已登录。内测阶段不对密钥做任何校验——非空即视为登录成功。
   *
   * main 职责：落盘登录态 + 写 Claude 覆盖文件 + 存桥密钥 + 返回桥 provider。
   * 桥 settings 的写入交给 renderer（走 settings.update IPC），保证 UI 刷新。
   * 各步失败都不阻断登录（登录态优先）。
   */
  login(secretKey: string): AuthStatus {
    const trimmed = secretKey.trim()
    if (trimmed.length === 0) {
      // 空密钥 = 登录失败，不动任何配置
      const state: AuthFile = { ...DEFAULT_STATE }
      this.cache = state
      writeFile(state)
      return { loggedIn: state.loggedIn, loginMethod: state.loginMethod }
    }
    const state: AuthFile = { loggedIn: true, loginMethod: 'secret-key' }
    this.cache = state
    writeFile(state)
    this.writeClaudeDefaultOverride(trimmed)
    // 存桥密钥（0600），renderer 碰不到，必须由 main 存
    setStoredCredential(INTERNAL_BETA_PROVIDER_ID, trimmed)
    // 返回桥 provider 让 renderer 写 settings.protocolBridge（走 IPC 链路刷新 UI）
    const provider = createInternalBetaProvider()
    return {
      loggedIn: state.loggedIn,
      loginMethod: state.loginMethod,
      internalBetaBridge: { provider },
    }
  }

  /**
   * 把内测默认 Claude 覆盖配置写到 claude.catmaxSettings，密钥占位符替换成真实值。
   * 复用 writeBackendConfigFile：拿到 0600 权限 + 512KB 限制 + 原子写 + 备份。
   *
   * Claude Settings Profiles: 先切到内测专用档再写。
   * 这里写的是 `force: true` 的整份覆盖——单档时代它会把用户手写的覆盖配置直接冲掉。
   * 现在它只落在自己那一档上，用户的档一个字节都不动，登出时也能连档带文件删干净。
   */
  private writeClaudeDefaultOverride(secretKey: string): void {
    const content = CLAUDE_INTERNAL_DEFAULT_OVERRIDE.replace(
      ANTHROPIC_AUTH_TOKEN_PLACEHOLDER,
      secretKey,
    )
    ensureInternalBetaProfile()
    const result = writeBackendConfigFile({
      id: 'claude.catmaxSettings',
      content,
      expectedMtimeMs: null, // 不做冲突检查
      force: true, // 每次登录强制覆盖
    })
    if (!result.ok) {
      log.warn('写入 Claude 默认覆盖配置失败，用户可在设置页手动配置', result)
    }
  }

  /**
   * 退出登录：清空登录态 + 删 Claude 覆盖文件 + 清桥密钥。
   *
   * main 职责：清登录态 + 删 Claude 覆盖 + 清 bridge-credentials 密钥。
   * 桥 settings 的清理交给 renderer（走 settings.update IPC）。
   * 各步失败都不阻断退出（登录态优先）。
   *
   * Claude Settings Profiles: 只删内测那一档（连档带文件），用户自己建的档保留；
   * 当前档若正是内测档，会回落到剩下的第一档，一档不剩才变成"不启用覆盖"。
   */
  logout(): AuthStatus {
    const state: AuthFile = { ...DEFAULT_STATE }
    this.cache = state
    writeFile(state)
    try {
      removeInternalBetaProfile()
    } catch (e) {
      log.warn('退出登录时删除 Claude 内测覆盖配置失败，密钥可能仍残留在磁盘', e)
    }
    try {
      clearStoredCredential(INTERNAL_BETA_PROVIDER_ID)
    } catch (e) {
      log.warn('退出登录时清除桥密钥失败，密钥可能仍残留在磁盘', e)
    }
    return { loggedIn: state.loggedIn, loginMethod: state.loginMethod }
  }
}
