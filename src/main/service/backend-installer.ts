/**
 * Backend Install: 把官方发布的 codex 产物下载到 app 自己的数据目录。
 *
 * 为什么不调 `npm i -g @openai/codex`：GUI app 里 npm/node 未必在 PATH，
 * 可能要 sudo，Windows 上体验尤其差。这里直接拉 npm registry 上的平台 tarball
 * （内容与 GitHub Release 的 codex-package-<triple>.tar.gz 完全一致），
 * 解压到 userData/backends/codex/<version>/，再把路径写进 settings.backendPaths.codex。
 * CodexAdapter 全程走 binaryPath（见 codex/adapter.ts 的 spawn），
 * 所以装完的 codex 不需要出现在 PATH 里。
 *
 * 安全：npm 的 dist.integrity（sha512）必须校验通过才落盘——下载失败/被篡改/
 * 镜像不同步都会在这一步拦下。官方源和 npmmirror 返回同一个 integrity 值，
 * 所以镜像回退不降低安全性。
 *
 * 网络：走 Electron 的 net 模块 + 独立 session，这样才能应用 settings.httpProxy
 * 配的代理（Node 的 global fetch 不读 HTTPS_PROXY）。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import {
  isInstallableBackend,
  type BackendInstallPhase,
  type BackendInstallProgress,
  type BackendInstallResult,
} from '@shared/backend/install'
import type { BackendId } from '@shared/constants'
import { app, net, session, type IncomingMessage, type Session } from 'electron'

import { checkCliHealth } from '../backend/health-check'
import { normalizeProxyUrl } from '../backend/proxy-env'

import { logger } from './logger'

const log = logger.domain('backend-installer')

const CODEX_PACKAGE = '@openai/codex'

/**
 * registry 候选源，按顺序试。
 * npmmirror 实测与官方返回同一个 dist.integrity，且同步及时——
 * 国内直连 registry.npmjs.org 拉 100MB 经常超时，所以留作回退。
 */
const REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com']

/** `${process.platform}-${process.arch}` → rust target triple（tarball 里 vendor/<triple>/ 的目录名） */
const TARGET_TRIPLES: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'win32-x64': 'x86_64-pc-windows-msvc',
}

/** 进度推送节流间隔——按 chunk 推会把 IPC 打爆（100MB / 64KB ≈ 1600 次） */
const PROGRESS_THROTTLE_MS = 200

/** 用户主动取消的哨兵错误——与真正的失败区分开，UI 不报红 */
class CancelledError extends Error {
  constructor() {
    super('installation cancelled')
    this.name = 'CancelledError'
  }
}

/** 带人类可读文案的安装失败 */
class InstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstallError'
  }
}

/** 进行中的安装：backendId → AbortController。同一 backend 同时只允许一个安装。 */
const running = new Map<BackendId, AbortController>()

export interface InstallBackendArgs {
  id: BackendId
  /** settings.httpProxy 解析出的代理 URL；null 表示走系统代理 */
  proxyUrl: string | null
  onProgress: (progress: BackendInstallProgress) => void
}

/**
 * 安装指定 backend。返回值永远是结构化结果，不抛异常——
 * 调用方（IPC handler）只需要根据 ok / cancelled 决定后续动作。
 */
export async function installBackend(args: InstallBackendArgs): Promise<BackendInstallResult> {
  const { id, proxyUrl, onProgress } = args

  if (!isInstallableBackend(id)) {
    return { ok: false, error: `${id} 不支持一键安装` }
  }
  if (running.has(id)) {
    return { ok: false, error: '已有一个安装任务在进行中' }
  }

  const controller = new AbortController()
  running.set(id, controller)

  // 进度推送包一层：补齐 backendId，记住已解析出的版本号
  let version: string | null = null
  const emit = (
    phase: BackendInstallPhase,
    extra?: { receivedBytes?: number; totalBytes?: number | null; error?: string },
  ): void => {
    onProgress({
      backendId: id,
      phase,
      receivedBytes: extra?.receivedBytes ?? 0,
      totalBytes: extra?.totalBytes ?? null,
      version,
      error: extra?.error ?? null,
    })
  }

  try {
    const result = await installCodex({
      proxyUrl,
      signal: controller.signal,
      emit,
      onVersionResolved: (v) => {
        version = v
      },
    })
    emit('done')
    return { ok: true, binaryPath: result.binaryPath, version: result.version }
  } catch (e) {
    if (e instanceof CancelledError || controller.signal.aborted) {
      emit('cancelled')
      return { ok: false, cancelled: true }
    }
    const message = e instanceof Error ? e.message : String(e)
    log.error('install failed:', message)
    emit('error', { error: message })
    return { ok: false, error: message }
  } finally {
    running.delete(id)
  }
}

/** 取消进行中的安装。没有进行中的安装时是 no-op。 */
export function cancelBackendInstall(id: BackendId): void {
  const controller = running.get(id)
  if (!controller) return
  log.info('cancelling install for', id)
  controller.abort()
}

// ============ codex 安装流程 ============

interface InstallCodexArgs {
  proxyUrl: string | null
  signal: AbortSignal
  emit: (
    phase: BackendInstallPhase,
    extra?: { receivedBytes?: number; totalBytes?: number | null; error?: string },
  ) => void
  onVersionResolved: (version: string) => void
}

async function installCodex(
  args: InstallCodexArgs,
): Promise<{ binaryPath: string; version: string }> {
  const { proxyUrl, signal, emit, onVersionResolved } = args

  const platformKey = `${process.platform}-${process.arch}`
  const triple = TARGET_TRIPLES[platformKey]
  if (!triple) {
    throw new InstallError(`不支持的平台：${platformKey}`)
  }

  const ses = await createInstallerSession(proxyUrl)

  // 1) 解析版本 + tarball 地址
  emit('resolving')
  const release = await resolveCodexRelease(ses, signal, platformKey)
  onVersionResolved(release.displayVersion)
  log.info('resolved codex', release.version, 'from', release.tarball)

  const rootDir = join(app.getPath('userData'), 'backends', 'codex')
  const targetDir = join(rootDir, release.version)
  const binaryPath = join(targetDir, 'bin', codexBinaryName())

  // 已经装过同一版本就直接复用——重装 300MB 没意义
  if (await pathExists(binaryPath)) {
    log.info('already installed at', binaryPath)
    emit('finalizing')
    await finalizeBinary(binaryPath)
    return { binaryPath, version: release.displayVersion }
  }

  await mkdir(rootDir, { recursive: true })
  // 下载和解压都先落到 .tmp 目录，全部成功后再 rename——
  // 中途失败/取消不会在 backends/ 下留半个可执行的版本目录
  const tmpDir = join(rootDir, `.tmp-${Date.now()}`)
  const tarPath = join(tmpDir, 'codex.tgz')
  await mkdir(tmpDir, { recursive: true })

  try {
    // 2) 下载
    emit('downloading', { receivedBytes: 0, totalBytes: null })
    let lastEmit = 0
    const digest = await downloadToFile({
      url: release.tarball,
      dest: tarPath,
      ses,
      signal,
      onProgress: (received, total) => {
        const now = Date.now()
        if (now - lastEmit < PROGRESS_THROTTLE_MS) return
        lastEmit = now
        emit('downloading', { receivedBytes: received, totalBytes: total })
      },
    })

    // 3) 校验 sha512
    emit('verifying')
    if (release.integrity) {
      const expected = parseSha512Integrity(release.integrity)
      if (expected && expected !== digest) {
        throw new InstallError('下载文件校验失败（sha512 不匹配），已丢弃。请重试或换个网络环境。')
      }
    } else {
      log.warn('registry did not provide dist.integrity; skipping checksum verification')
    }

    // 4) 解压：tarball 里是 package/vendor/<triple>/{bin,codex-path,codex-resources}，
    //    strip 掉前 3 层，直接把 vendor/<triple> 的内容摊到目标目录
    emit('extracting')
    const extractDir = join(tmpDir, 'out')
    await mkdir(extractDir, { recursive: true })
    await extractTarball({ tarPath, destDir: extractDir, triple, signal })

    const extractedBinary = join(extractDir, 'bin', codexBinaryName())
    if (!(await pathExists(extractedBinary))) {
      throw new InstallError('解压后没找到 codex 可执行文件，产物结构可能变了')
    }

    // 5) 收尾：chmod + 健康检查
    emit('finalizing')
    await finalizeBinary(extractedBinary)

    await rm(targetDir, { recursive: true, force: true })
    await rename(extractDir, targetDir)

    const health = checkCliHealth(binaryPath, ['--version'])
    if (!health.ok) {
      throw new InstallError(`安装完成但无法运行（${health.error}）。可能被系统安全策略拦截。`)
    }

    // 旧版本目录留着只是占地方（每个 ~330MB），装成功后清掉
    await pruneOldVersions(rootDir, release.version)

    return { binaryPath, version: release.displayVersion }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

interface ResolvedRelease {
  /** 平台包版本号，形如 0.146.0-darwin-arm64 */
  version: string
  /** 展示给用户的版本号，形如 0.146.0 */
  displayVersion: string
  tarball: string
  integrity: string | null
}

/**
 * 查 registry 拿当前平台的 tarball 地址。
 *
 * codex 的平台包是「同名不同版本」的别名依赖：
 *   "@openai/codex-darwin-arm64": "npm:@openai/codex@0.146.0-darwin-arm64"
 * 所以先读 latest 的 optionalDependencies 解析出平台版本号，再查那个版本的 dist。
 */
async function resolveCodexRelease(
  ses: Session,
  signal: AbortSignal,
  platformKey: string,
): Promise<ResolvedRelease> {
  let lastError: unknown = null

  for (const registry of REGISTRIES) {
    try {
      const latest = (await fetchJson(`${registry}/${CODEX_PACKAGE}/latest`, ses, signal)) as {
        version?: string
        optionalDependencies?: Record<string, string>
      }
      const displayVersion = latest.version
      if (!displayVersion) throw new InstallError('registry 返回的 latest 没有版本号')

      const alias = latest.optionalDependencies?.[`${CODEX_PACKAGE}-${platformKey}`]
      // 别名解析失败就按命名约定兜底拼一个，下一步查不到会自然报错
      const version = parseAliasVersion(alias) ?? `${displayVersion}-${platformKey}`

      const meta = (await fetchJson(`${registry}/${CODEX_PACKAGE}/${version}`, ses, signal)) as {
        dist?: { tarball?: string; integrity?: string }
      }
      const tarball = meta.dist?.tarball
      if (!tarball) throw new InstallError(`registry 没有 ${version} 的 tarball 地址`)

      return {
        version,
        displayVersion,
        tarball,
        integrity: meta.dist?.integrity ?? null,
      }
    } catch (e) {
      if (e instanceof CancelledError || signal.aborted) throw e
      log.warn(`registry ${registry} failed:`, e instanceof Error ? e.message : e)
      lastError = e
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  throw new InstallError(`无法连接 npm registry 获取 codex 版本信息：${detail}`)
}

/** "npm:@openai/codex@0.146.0-darwin-arm64" → "0.146.0-darwin-arm64"（导出仅为单测） */
export function parseAliasVersion(alias: string | undefined): string | null {
  if (!alias) return null
  const match = alias.match(/^npm:@[^@]+@(.+)$/)
  return match?.[1] ?? null
}

/** "sha512-<base64>" → base64 部分；不是 sha512 时返回 null（跳过校验）。导出仅为单测。 */
export function parseSha512Integrity(integrity: string): string | null {
  const entry = integrity.split(/\s+/).find((part) => part.startsWith('sha512-'))
  return entry ? entry.slice('sha512-'.length) : null
}

function codexBinaryName(): string {
  return process.platform === 'win32' ? 'codex.exe' : 'codex'
}

/** chmod +x（tar 一般已经保留了权限位，这里兜底；Windows 不需要） */
async function finalizeBinary(binaryPath: string): Promise<void> {
  if (process.platform === 'win32') return
  await chmod(binaryPath, 0o755).catch((e) => {
    log.warn('chmod failed:', e)
  })
}

/** 清掉除 keepVersion 外的其它版本目录（每个约 330MB） */
async function pruneOldVersions(rootDir: string, keepVersion: string): Promise<void> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === keepVersion) continue
      if (entry.name.startsWith('.tmp-')) continue
      await rm(join(rootDir, entry.name), { recursive: true, force: true })
      log.info('pruned old version', entry.name)
    }
  } catch (e) {
    log.warn('pruneOldVersions failed:', e)
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

// ============ 网络 ============

/**
 * 安装专用的 Electron session。
 * 用非持久化 partition，避免污染主 session 的 cookie/缓存；
 * 代理走 settings.httpProxy，没配就跟随系统代理。
 */
async function createInstallerSession(proxyUrl: string | null): Promise<Session> {
  const ses = session.fromPartition('backend-installer')
  if (proxyUrl) {
    // 和注入给 CLI 子进程的代理走同一套规范化，避免用户只填 host:port 时两条链路表现不一致
    await ses.setProxy({ proxyRules: normalizeProxyUrl(proxyUrl) })
  } else {
    await ses.setProxy({ mode: 'system' })
  }
  return ses
}

/**
 * Electron 的 IncomingMessage 运行时实现了 Readable Stream 接口（官方文档明说），
 * 但 electron.d.ts 只声明它继承 EventEmitter，没有 pause/resume。
 * 下载要做背压，只能在类型上补回来。
 */
type ReadableIncomingMessage = IncomingMessage & Pick<NodeJS.ReadableStream, 'pause' | 'resume'>

/** 发起请求并在 2xx 时把响应流交出来；非 2xx / abort 都会 reject */
function openRequest(
  url: string,
  ses: Session,
  signal: AbortSignal,
): Promise<ReadableIncomingMessage> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new CancelledError())
      return
    }
    const request = net.request({ url, session: ses, redirect: 'follow' })
    const onAbort = (): void => request.abort()
    signal.addEventListener('abort', onAbort, { once: true })

    request.on('response', (response) => {
      const stream = response as ReadableIncomingMessage
      const status = response.statusCode
      if (status < 200 || status >= 300) {
        stream.resume() // 丢弃 body，否则连接不释放
        reject(new InstallError(`HTTP ${status}：${url}`))
        return
      }
      resolve(stream)
    })
    request.on('abort', () => reject(new CancelledError()))
    request.on('error', (err) => reject(err))
    request.end()
  })
}

async function fetchJson(url: string, ses: Session, signal: AbortSignal): Promise<unknown> {
  const response = await openRequest(url, ses, signal)
  const chunks: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    response.on('data', (chunk: Buffer) => chunks.push(chunk))
    response.on('end', () => resolve())
    response.on('error', (err: Error) => reject(err))
    response.on('aborted', () => reject(new CancelledError()))
  })
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'))
}

interface DownloadArgs {
  url: string
  dest: string
  ses: Session
  signal: AbortSignal
  onProgress: (received: number, total: number | null) => void
}

/** 边下边算 sha512，返回 base64 摘要（与 npm 的 dist.integrity 同格式） */
async function downloadToFile(args: DownloadArgs): Promise<string> {
  const { url, dest, ses, signal, onProgress } = args
  const response = await openRequest(url, ses, signal)

  const lengthHeader = response.headers['content-length']
  const rawLength = Array.isArray(lengthHeader) ? lengthHeader[0] : lengthHeader
  const total = rawLength ? Number(rawLength) : null
  const totalBytes = total !== null && Number.isFinite(total) ? total : null

  const hash = createHash('sha512')
  const out = createWriteStream(dest)
  let received = 0

  try {
    await new Promise<void>((resolve, reject) => {
      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        hash.update(chunk)
        // 背压：磁盘写不过网络时暂停接收，避免 300MB 全堆在内存里
        if (!out.write(chunk)) {
          response.pause()
          out.once('drain', () => response.resume())
        }
        onProgress(received, totalBytes)
      })
      response.on('end', () => out.end(() => resolve()))
      response.on('error', (err: Error) => reject(err))
      response.on('aborted', () => reject(new CancelledError()))
      out.on('error', (err) => reject(err))
    })
  } finally {
    // 取消/出错时 write stream 还开着——不 destroy 的话文件句柄要等 GC，
    // Windows 上会让外层的 rm(tmpDir) 失败并留下几百 MB 垃圾
    out.destroy()
  }

  onProgress(received, totalBytes)
  return hash.digest('base64')
}

// ============ 解压 ============

interface ExtractArgs {
  tarPath: string
  destDir: string
  triple: string
  signal: AbortSignal
}

/**
 * 用系统 tar 解压（macOS/Linux 自带；Windows 10 1803+ 自带 bsdtar）。
 * 不引第三方解压依赖——tarball 300MB+，走系统 tar 既省内存又省依赖。
 */
function extractTarball(args: ExtractArgs): Promise<void> {
  const { tarPath, destDir, triple, signal } = args
  return new Promise((resolve, reject) => {
    const child = spawn(
      'tar',
      ['-xzf', tarPath, '-C', destDir, '--strip-components=3', `package/vendor/${triple}`],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )

    const onAbort = (): void => {
      child.kill('SIGKILL')
    }
    signal.addEventListener('abort', onAbort, { once: true })

    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new InstallError('系统里没有 tar 命令，无法解压。请改用手动安装。'))
        return
      }
      reject(err)
    })

    child.on('close', (code, sig) => {
      if (signal.aborted) {
        reject(new CancelledError())
        return
      }
      if (code === 0) {
        resolve()
        return
      }
      reject(new InstallError(`解压失败（tar exit=${code} signal=${sig}）：${stderr.trim()}`))
    })
  })
}
