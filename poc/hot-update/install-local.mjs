/**
 * Hot Update Phase 2 验证：把 release/ 里的包按**真实安装流程**装进 userData。
 *
 *   node poc/hot-update/install-local.mjs
 *
 * 它走的是设计文档 §5.6 / §5.8 定义的完整路径，唯一的区别是数据源来自本地
 * release/ 而不是 HTTP——因此这同时也是 Phase 3 安装器的原型：
 *
 *   读 manifest → 算 sha256 → checkUpdate（验签 + 版本 + 环境守门）
 *   → 解压到 staging/ → 校验完整性 → rename 进 versions/ → 写 state.staged
 *
 * 关键是**先解压到 staging 再 rename**：同分区 rename 是原子的，所以 versions/
 * 下永远不会出现半个版本。直接解压进 versions/ 会在断电时留下一个结构完整但
 * 内容残缺的目录，而 bootstrap 的状态机分辨不出它和一个正常版本的区别。
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { UPDATE_PUBLIC_KEY } from '../../src/bootstrap/public-key.mjs'
import { checkUpdate } from '../../src/bootstrap/signing.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const RELEASE = join(ROOT, 'release')
const USER_DATA = join(homedir(), 'Library/Application Support/catmax-app')
const HOT_ROOT = join(USER_DATA, 'hot-updates')
const VERSIONS = join(HOT_ROOT, 'versions')
const STAGING = join(HOT_ROOT, 'staging')
const STATE_FILE = join(HOT_ROOT, 'state.json')

// manifest.json = 已发布，manifest.pending.json = 已签名待上传。本地验证两种都能装，
// 优先已发布的那份（它才是线上客户端真正会拿到的内容）。
const manifestFile = ['manifest.json', 'manifest.pending.json']
  .map((n) => join(RELEASE, n))
  .find((p) => existsSync(p))
if (!manifestFile) throw new Error('release/ 下没有 manifest，请先跑 scripts/release-hot.mjs')

const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
const { latest } = manifest
const tarball = join(RELEASE, `h${latest.hotVersion}.tar.gz`)

if (!existsSync(tarball)) throw new Error(`找不到 ${tarball}`)

// 宿主事实：真实客户端从 app.getVersion() 和 out/bootstrap/runtime-id.json 取
const hostRuntimeId = JSON.parse(
  readFileSync(join(ROOT, 'out/bootstrap/runtime-id.json'), 'utf8'),
).runtimeId
const appVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null
const currentHotVersion = state?.confirmed ?? 0

const actualSha256 = crypto.createHash('sha256').update(readFileSync(tarball)).digest('hex')

const result = checkUpdate(crypto, UPDATE_PUBLIC_KEY, latest, actualSha256, {
  appVersion,
  runtimeId: hostRuntimeId,
  currentHotVersion,
})

if (!result.ok) {
  console.error(`❌ 校验未通过：${result.reason}`)
  if (result.poisoned) {
    console.error(
      '   ⚠️  这是投毒信号（验签失败或版本回退），真实客户端此时必须停止本轮更新并记录，',
    )
    console.error('       绝不能像 sha256 不匹配那样"重试一次"。')
  }
  process.exit(1)
}
console.log(`  ✓ 校验通过：sha256 一致、Ed25519 验签通过、版本与环境守门均放行`)

// 解压到 staging，成功后才 rename 进 versions
rmSync(STAGING, { recursive: true, force: true })
mkdirSync(STAGING, { recursive: true })
const stageTarget = join(STAGING, `h${latest.hotVersion}`)
mkdirSync(stageTarget, { recursive: true })
execFileSync('tar', ['-xzf', tarball, '-C', stageTarget])

// 完整性自检：main/index.js 是 bootstrap 判定"版本存在"的依据，
// 它缺失的话会让状态机以为这个版本可用，然后每次启动都失败到回滚为止。
for (const required of ['main/index.js', 'preload', 'renderer/index.html', 'package.json']) {
  if (!existsSync(join(stageTarget, required))) {
    rmSync(STAGING, { recursive: true, force: true })
    throw new Error(`包内缺少 ${required}，拒绝安装`)
  }
}

mkdirSync(VERSIONS, { recursive: true })
const finalTarget = join(VERSIONS, `h${latest.hotVersion}`)
rmSync(finalTarget, { recursive: true, force: true })
renameSync(stageTarget, finalTarget)
rmSync(STAGING, { recursive: true, force: true })
console.log(`  ✓ 已安装到 ${finalTarget}`)

// staged 而不是直接 active：下载完成 ≠ 立即生效（§5.6、§5.7）。
// 真实客户端还要检查有没有正在运行的 turn 才会提示用户重启。
const nextState = {
  baseVersion: appVersion,
  runtimeId: hostRuntimeId,
  active: state?.active ?? 0,
  confirmed: state?.confirmed ?? 0,
  staged: latest.hotVersion,
  bootAttempts: state?.bootAttempts ?? 0,
  lastCheckAt: Date.now(),
}
mkdirSync(HOT_ROOT, { recursive: true })
writeFileSync(STATE_FILE, `${JSON.stringify(nextState, null, 2)}\n`)

console.log(`  ✓ state.staged = h${latest.hotVersion}（下次启动生效）`)
console.log(`\n✅ 安装完成。启动打包后的 app 即可看到 h${latest.hotVersion} 生效。`)
