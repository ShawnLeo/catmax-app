/**
 * Protocol Bridge 的上游凭证存储。
 *
 * ⚠️ 这是 catmax 里**唯一**会落盘密钥的地方，是对「catmax 不存任何凭证」原则的
 * 一次有意破例——协议桥必须自己持有上游 key 才能转发，没有别的办法。
 * 为此做了三点收紧：
 *
 * 1. **不进 settings.json**。settings.json 是 0644、会被备份/同步、renderer 能整份读走。
 *    密钥单独存一个文件，权限 0600，且 settings 里只留「用哪个来源」的元信息。
 * 2. **默认推荐环境变量来源**。用 `credentialSource: 'env'` 时这里一个字节都不写。
 * 3. **只出不进 renderer**。IPC 只回传 `credentialReady: boolean`，密钥本身永远不过 IPC。
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

import { app } from 'electron'

import { logger } from './logger'

const log = logger.domain('bridge-credentials')

const FILE_MODE = 0o600
const DIR_MODE = 0o700

interface CredentialFile {
  /** key = provider id（UUID），value = 明文 key */
  secrets: Record<string, string>
}

function credentialPath(): string {
  // app.getPath 在测试环境不可用，退回临时目录，避免测试往真实 userData 写东西
  let base: string
  try {
    base = app.getPath('userData')
  } catch {
    base = join(process.env.TMPDIR ?? '/tmp', 'catmax-test-userdata')
  }
  return join(base, 'bridge-credentials.json')
}

function readFile(): CredentialFile {
  const path = credentialPath()
  if (!existsSync(path)) return { secrets: {} }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    const secrets =
      typeof parsed === 'object' && parsed !== null ? (parsed as CredentialFile).secrets : undefined
    return { secrets: typeof secrets === 'object' && secrets !== null ? secrets : {} }
  } catch (error) {
    log.warn('凭证文件损坏，按空处理', error instanceof Error ? error.message : String(error))
    return { secrets: {} }
  }
}

/** 同目录临时文件 + fsync + rename 原子替换，并显式 chmod（openSync 的 mode 会被 umask 削） */
function writeFile(content: CredentialFile): void {
  const path = credentialPath()
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
  const tmpPath = join(dirname(path), `.bridge-cred-${randomBytes(6).toString('hex')}.tmp`)
  try {
    const fd = openSync(tmpPath, 'wx', FILE_MODE)
    try {
      writeSync(fd, JSON.stringify(content), null, 'utf-8')
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

export function setStoredCredential(id: string, secret: string): void {
  const file = readFile()
  if (secret) {
    file.secrets[id] = secret
  } else {
    delete file.secrets[id]
  }
  writeFile(file)
}

export function getStoredCredential(id: string): string | null {
  const secret = readFile().secrets[id]
  return secret && secret.length > 0 ? secret : null
}

export function hasStoredCredential(id: string): boolean {
  return getStoredCredential(id) !== null
}

export function clearStoredCredential(id: string): void {
  setStoredCredential(id, '')
}
