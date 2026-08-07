/**
 * Hot Update: 客户端的检查 / 下载 / 验签 / 安装（设计文档 §5.6、§5.7、§5.8）。
 *
 * 与 `poc/hot-update/install-local.mjs` 走的是同一条路径，区别只是数据源从本地
 * `release/` 换成 HTTP。顺序不能动：
 *
 *   拉 manifest → 下载到 staging → 算 sha256 → **验签** → 解压 → 完整性自检
 *   → rename 进 versions/ → 写 state.staged → 等用户重启
 *
 * 两个必须守住的点：
 *   1. **验签在解压之前**。先解压再验签等于把未经验证的文件写进 versions/，
 *      而 bootstrap 只看目录是否存在就会去加载它。
 *   2. **绝不自动重启**（§5.7）。catmax 是托盘常驻应用，重启会让所有运行中的
 *      turn 被 `recoverInterrupted()` 不可逆地标记为 interrupted。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { PUSH } from '@shared/constants'
import type { HotUpdateStatus } from '@shared/ipc/update'
import { app } from 'electron'

import { ctx } from '../context'

import {
  hotUpdateHost,
  type HotUpdateHost,
  type HotUpdateManifest,
  type HotUpdateManifestEntry,
} from './hot-update-host'
import { logger } from './logger'

const execFileAsync = promisify(execFile)
const log = logger.domain('hot-update')

/**
 * manifest 地址。**改这个常量等于把老客户端留在旧地址上**——它们只会去问自己
 * 编译进去的那个 URL，所以旧地址必须长期保留（§6.6 的路径约定）。
 */
const MANIFEST_URL = 'https://hot.toolpie.dev/catmax/hot/manifest.json'

/** 启动后首次检查的延迟：避开启动高峰（§5.6） */
const FIRST_CHECK_DELAY_MS = 30 * 1000

/**
 * 检查间隔。**改小之前必须回看设计文档 §6.6 的那张表**：这是整个方案里唯一一个
 * 改一个常量就让成本量级变化的地方——4 小时对应约 4.7 万用户的免费额度天花板，
 * 改成 5 分钟会降到约 1150 人。
 */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/** 下载超时。包只有几 MB，超过这个时间基本是网络不通而不是慢 */
const DOWNLOAD_TIMEOUT_MS = 60 * 1000
const MANIFEST_TIMEOUT_MS = 15 * 1000

/** 解压后必须存在的东西，缺一不可（与 install-local.mjs 保持一致） */
const REQUIRED_ENTRIES = ['main/index.js', 'preload', 'renderer/index.html', 'package.json']

type State = HotUpdateStatus['state']

let state: State = 'idle'
let errorMessage: string | undefined
let staged: { hotVersion: number; releaseNotes?: string } | null = null
let lastCheckAt: number | undefined
let checking = false
let timer: ReturnType<typeof setTimeout> | null = null

/** 有活跃 turn 时不允许重启（§5.7）。由 index.ts 注入，避免 service 反向依赖 backend。 */
let countActiveTurns: () => number = () => 0

export function setActiveTurnProbe(probe: () => number): void {
  countActiveTurns = probe
}

function versionLabel(host: HotUpdateHost, hotVersion: number): string {
  return hotVersion > 0 ? `${host.host.appVersion} (h${hotVersion})` : host.host.appVersion
}

export function getStatus(): HotUpdateStatus {
  const host = hotUpdateHost()
  if (!host) {
    // dev 模式：bootstrap 没参与，热更新整体关闭
    return { supported: false, state: 'idle', currentVersion: app.getVersion(), activeTurns: 0 }
  }
  return {
    supported: true,
    state,
    currentVersion: versionLabel(host, host.host.activeHotVersion),
    ...(staged ? { stagedVersion: versionLabel(host, staged.hotVersion) } : {}),
    ...(staged?.releaseNotes ? { releaseNotes: staged.releaseNotes } : {}),
    ...(errorMessage ? { error: errorMessage } : {}),
    ...(lastCheckAt ? { lastCheckAt } : {}),
    // 门禁在 main 侧判定：renderer 拿到的是结论而不是 turn 列表，
    // 避免两边各写一套"什么算活跃"的规则然后慢慢分叉。
    activeTurns: countActiveTurns(),
  }
}

function broadcast(): void {
  ctx.broadcast(PUSH.UPDATE_STATUS_CHANGED, getStatus())
}

function setState(next: State, error?: string): void {
  state = next
  errorMessage = error
  broadcast()
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/**
 * 下载到内存再落盘。包只有几 MB，流式写盘换来的复杂度不值得；但**必须核对
 * 声明大小**——否则一个恶意或损坏的响应可以无限膨胀直到进程 OOM。
 */
async function download(entry: HotUpdateManifestEntry): Promise<Buffer> {
  const res = await fetch(entry.url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)

  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared && declared !== entry.size) {
    throw new Error(`大小与 manifest 不符：${declared} ≠ ${entry.size}`)
  }

  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength !== entry.size) {
    throw new Error(`下载内容大小异常：${buf.byteLength} ≠ ${entry.size}`)
  }
  return buf
}

/**
 * 解压到 staging，自检通过后 rename 进 versions/。
 *
 * rename 是同分区原子操作，所以 `versions/` 下永远不会出现半个版本。直接解压进
 * versions/ 会在断电时留下一个结构完整但内容残缺的目录，而 bootstrap 的状态机
 * 分辨不出它和一个正常版本的区别，只会一次次启动失败到回滚为止。
 */
async function installTarball(
  host: HotUpdateHost,
  entry: HotUpdateManifestEntry,
  bytes: Buffer,
): Promise<void> {
  const { stagingDir, versionsDir } = host.paths
  rmSync(stagingDir, { recursive: true, force: true })
  mkdirSync(stagingDir, { recursive: true })

  const tarPath = join(stagingDir, `h${entry.hotVersion}.tar.gz`)
  const stageTarget = join(stagingDir, `h${entry.hotVersion}`)
  writeFileSync(tarPath, bytes)
  mkdirSync(stageTarget, { recursive: true })

  try {
    await execFileAsync('tar', ['-xzf', tarPath, '-C', stageTarget])

    for (const required of REQUIRED_ENTRIES) {
      if (!existsSync(join(stageTarget, required))) {
        throw new Error(`包内缺少 ${required}`)
      }
    }

    mkdirSync(versionsDir, { recursive: true })
    const finalTarget = join(versionsDir, `h${entry.hotVersion}`)
    rmSync(finalTarget, { recursive: true, force: true })
    renameSync(stageTarget, finalTarget)
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
}

/**
 * 跑一轮检查。`manual` 只影响日志与错误可见性：自动检查失败不打扰用户（§5.6），
 * 手动检查失败要让用户看到，否则点了按钮没反应更让人困惑。
 */
export async function checkForUpdate(manual = false): Promise<HotUpdateStatus> {
  const host = hotUpdateHost()
  if (!host) return getStatus()
  if (checking) return getStatus()

  checking = true
  setState('checking')

  try {
    const manifest = (await fetchJson(MANIFEST_URL, MANIFEST_TIMEOUT_MS)) as HotUpdateManifest
    const entry = manifest?.latest
    if (!entry?.hotVersion) throw new Error('manifest 格式异常')

    lastCheckAt = Date.now()
    host.touchLastCheck()

    // 已经装好待生效的版本也算"当前"，否则每轮检查都会把同一个包重下一遍
    const current = Math.max(host.host.activeHotVersion, staged?.hotVersion ?? 0)
    if (entry.hotVersion <= current) {
      setState('idle')
      return getStatus()
    }

    setState('downloading')
    const bytes = await download(entry)
    const actualSha256 = createHash('sha256').update(bytes).digest('hex')

    // 验签在解压之前。这里的 check 来自 asar 内的 bootstrap，公钥不可能被热更新替换。
    const verdict = host.check(entry, actualSha256, current)
    if (!verdict.ok) {
      if (verdict.poisoned) {
        // 投毒信号（验签失败 / 版本回退）：必须停止本轮并留痕，绝不像 sha256
        // 不匹配那样"重试一次"——重试只会把攻击者的包再下一遍。
        log.error('拒绝更新（投毒信号）', { reason: verdict.reason, hotVersion: entry.hotVersion })
        host.log(`⚠️ 拒绝 h${entry.hotVersion}：${verdict.reason}（投毒信号）`)
      } else {
        log.warn('拒绝更新', { reason: verdict.reason })
      }
      throw new Error(verdict.reason)
    }

    await installTarball(host, entry, bytes)
    host.stage(entry.hotVersion)
    staged = {
      hotVersion: entry.hotVersion,
      ...(entry.releaseNotes ? { releaseNotes: entry.releaseNotes } : {}),
    }
    host.log(`✅ h${entry.hotVersion} 已下载并验签通过，等待用户重启生效`)
    setState('staged')
    return getStatus()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // 自动检查失败保持 idle：网络不通是常态，没必要在 UI 上留一个红点
    if (manual) setState('error', message)
    else setState('idle')
    log.warn('检查更新失败', { manual, message })
    return getStatus()
  } finally {
    checking = false
  }
}

/**
 * 应用更新：重启进程。
 *
 * 必须 `relaunch()` + `quit()`，不能用 `exit()`——只有 quit 会触发 `before-quit`，
 * 那里负责 dispose 后端与 bridge。
 */
export function applyUpdate(): { ok: boolean; reason?: string } {
  if (!staged) return { ok: false, reason: '没有待生效的更新' }
  const active = countActiveTurns()
  if (active > 0) {
    // 这里再挡一次，不只依赖 UI 置灰：UI 的 activeTurns 是推送来的快照，
    // 用户点击的那一刻完全可能已经有新 turn 开始了。
    return { ok: false, reason: `还有 ${active} 个会话正在运行，重启会中断且无法恢复` }
  }
  app.relaunch()
  app.quit()
  return { ok: true }
}

function scheduleNext(delay: number): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    void checkForUpdate().finally(() => scheduleNext(CHECK_INTERVAL_MS))
  }, delay)
  // 托盘常驻应用里定时器不该成为退出的阻碍
  timer.unref?.()
}

/** 由 main 入口在 app ready 后调用一次。dev 模式下自动空转。 */
export function startHotUpdateScheduler(): void {
  const host = hotUpdateHost()
  if (!host) {
    log.info('未经 bootstrap 启动（dev 模式），热更新关闭')
    return
  }

  // 上次运行已经装好、还没生效的版本：进程重启后 staged 仍在 state.json 里，
  // 但内存状态是空的。不恢复的话卡片会消失，用户再也看不到"重启以更新"。
  const stagedVersion = host.host.stagedHotVersion
  if (stagedVersion > host.host.activeHotVersion) {
    staged = { hotVersion: stagedVersion }
    state = 'staged'
  }

  scheduleNext(FIRST_CHECK_DELAY_MS)
  log.info('热更新调度已启动', {
    active: host.host.activeHotVersion,
    staged: stagedVersion,
  })
}

export function stopHotUpdateScheduler(): void {
  if (timer) clearTimeout(timer)
  timer = null
}
