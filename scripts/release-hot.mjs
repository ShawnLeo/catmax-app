/**
 * Hot Update: 打包并签名一个热更新包。
 *
 *   node scripts/release-hot.mjs --notes "修复会话标题回填"           # 只签名，不上传
 *   node scripts/release-hot.mjs --notes "..." --publish            # 签完直接发布
 *   node scripts/release-hot.mjs --notes "..." --dry-run
 *
 * 做完这些事，**本脚本自身不联网**（上传是 `publish-hot.mjs` 的职责，`--publish`
 * 只是替你调它一次，见设计文档 §9.4）：
 *   1. 校验 runtimeId 未变（变了就只能发完整安装包，§9.1）
 *   2. 打 out/{main,preload,renderer} + 模块类型声明 → release/h<N>.tar.gz
 *   3. **断言包内不含 bootstrap / node_modules / 应用 package.json**
 *   4. sha256 → Ed25519 签名（离线私钥）
 *   5. 递增 hotVersion，生成 release/manifest.pending.json（**待发布**状态）
 *
 * 为什么这些步骤必须是确定性脚本、而不能交给 agent 每次现写（§9.4）：
 * 漏写 `--remote` 只是发布失败，你立刻会发现；而**漏掉第 3 步的断言是静默地
 * 把整个验签机制掏空**——公钥一旦能被热更新包替换，攻击者投一个包就能把验签
 * 换成空实现，而这一切看起来都正常。
 */
import { execFileSync } from 'node:child_process'
import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { signingPayload } from '../src/bootstrap/signing.mjs'
import { tarballUrl } from './hot-update-config.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'out')
const RELEASE_DIR = join(ROOT, 'release')
const MANIFEST = join(RELEASE_DIR, 'manifest.json')
const PENDING = join(RELEASE_DIR, 'manifest.pending.json')
const DEFAULT_KEY = join(homedir(), '.catmax/hot-update-signing-key.pem')

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}
const has = (name) => args.includes(`--${name}`)

const dryRun = has('dry-run')
const notes = flag('notes') ?? ''
const keyPath = flag('key') ?? process.env.CATMAX_SIGNING_KEY ?? DEFAULT_KEY

function die(msg) {
  console.error(`\n❌ ${msg}\n`)
  process.exit(1)
}

// ---- 1. 前置检查 ----

if (!existsSync(join(OUT, 'main/index.js'))) die('out/main 不存在，请先跑 pnpm build')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const baseVersion = pkg.version

const runtimeIdFile = join(OUT, 'bootstrap/runtime-id.json')
if (!existsSync(runtimeIdFile)) die('out/bootstrap/runtime-id.json 不存在，请先跑 pnpm build')
const { runtimeId } = JSON.parse(readFileSync(runtimeIdFile, 'utf8'))

// 记进 manifest 供 show-hot-changes.mjs 用：下次发布时用它算 `git log <commit>..HEAD`，
// 免得每次发布都要人工回忆"上次发到哪了"。只记最近一次提交——工作区若有未提交改动，
// pnpm build 已经把它们打进 out/ 了，但这里记不到，所以下面单独警告一次。
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
if (dirty) {
  console.log(
    `  ⚠️  工作区有未提交改动，它们会被打进这次的包，但不会体现在 commit 记录里：\n` +
      dirty
        .split('\n')
        .map((l) => `       ${l}`)
        .join('\n'),
  )
}

// `manifest.json` 的语义是**已成功发布到 R2 的状态**，`manifest.pending.json` 是
// 已打包签名但尚未上传成功的状态。分成两个文件是为了让版本号推导幂等：上传失败后
// 重跑本脚本必须复用同一个 hotVersion，否则每失败一次就烧掉一个版本号，manifest
// 里会出现永远不存在于 R2 的空洞版本，而 §6.6 的服务端下架依赖"旧包还在"。
const prev = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : null
const prevLatest = prev?.latest
const pending = existsSync(PENDING) ? JSON.parse(readFileSync(PENDING, 'utf8')) : null

// §9.1 通道判定：native 环境变了就不能走热更新，只能发完整安装包
if (prevLatest && prevLatest.runtimeId !== runtimeId) {
  die(
    `runtimeId 已变化（${prevLatest.runtimeId} → ${runtimeId}），不能发热更新。\n` +
      `   native 依赖或 Electron 版本变了，热更新的 JS 会在旧 native 上加载即崩。\n` +
      `   这次必须发完整安装包（pnpm dist:mac），并把 baseVersion 递增。`,
  )
}
if (prevLatest && prevLatest.baseVersion !== baseVersion) {
  die(
    `baseVersion 已变化（${prevLatest.baseVersion} → ${baseVersion}）。\n` +
      `   宿主版本变了说明发过完整安装包，热更新序号应重新从 1 开始：\n` +
      `   先手动清空 release/manifest.json 再跑本脚本。`,
  )
}

const hotVersion = pending?.latest?.hotVersion ?? (prevLatest?.hotVersion ?? 0) + 1
if (pending) {
  console.log(
    `  • 发现未发布的 h${hotVersion}（release/manifest.pending.json），复用该版本号重新打包`,
  )
}

if (!existsSync(keyPath)) {
  die(
    `找不到签名私钥：${keyPath}\n` +
      `   首次使用请先跑：node scripts/generate-signing-key.cjs\n` +
      `   或用 --key <路径> / 环境变量 CATMAX_SIGNING_KEY 指定。`,
  )
}

// ---- 2. 打包 ----

mkdirSync(RELEASE_DIR, { recursive: true })
const stageDir = join(RELEASE_DIR, `.stage-h${hotVersion}`)
const tarball = join(RELEASE_DIR, `h${hotVersion}.tar.gz`)

rmSync(stageDir, { recursive: true, force: true })
mkdirSync(stageDir, { recursive: true })

for (const sub of ['main', 'preload', 'renderer']) {
  execFileSync('cp', ['-R', join(OUT, sub), join(stageDir, sub)])
}

// Phase 0 实测：没有这个文件，侧载必定失败（设计文档 §0.3、§6.2）。
// .js 的模块类型由最近的 package.json 的 type 字段决定；userData 那棵目录树里
// 没有任何 package.json，Node 会按 CJS 解析，撞上顶层 import 直接 SyntaxError。
// 注意它只声明模块类型，与"不得包含应用的 package.json"并不冲突。
writeFileSync(join(stageDir, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`)

// ---- 3. 安全断言（不可跳过）----

const FORBIDDEN = [
  ['bootstrap', 'bootstrap 自身'],
  ['node_modules', 'node_modules'],
  ['runtime-id.json', 'runtimeId 指纹'],
  ['public-key.mjs', '验签公钥'],
  ['signing.mjs', '验签逻辑'],
]

const staged = execFileSync('find', [stageDir, '-type', 'f'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .map((p) => p.slice(stageDir.length + 1))

for (const [needle, label] of FORBIDDEN) {
  const hit = staged.filter((p) => p.split('/').includes(needle) || p.endsWith(needle))
  if (hit.length > 0) {
    die(
      `安全断言失败：热更新包内出现了${label}\n` +
        hit.map((h) => `     ${h}`).join('\n') +
        `\n   这些东西必须留在 asar 内、永不参与热更新（设计文档 §8.4）。` +
        `\n   它们一旦可被远程替换，验签机制等于不存在。`,
    )
  }
}

// 应用的 package.json 会带进 main 字段、dependencies、version，与我们刚写的
// 那个只含 {"type":"module"} 的文件是两回事。用内容而不是路径来区分。
const rootPkg = JSON.parse(readFileSync(join(stageDir, 'package.json'), 'utf8'))
if (Object.keys(rootPkg).length !== 1 || rootPkg.type !== 'module') {
  die('安全断言失败：包内的 package.json 不是纯模块类型声明，疑似混入了应用的 package.json')
}

// 上面的文件名断言只能抓"以独立文件形式混入"的情况，抓不到**被 bundle 进
// index.js** 的情况——只要有人在 src/main/** 里 import 了 public-key.mjs，
// vite 就会把公钥内联进 out/main/index.js，文件名一个都匹配不上，而热更新包
// 里从此带着一份可被替换的公钥副本。所以再按内容搜一遍特征串。
const CONTENT_MARKERS = [
  // 公钥 PEM 的 base64 主体（去掉头尾和换行后的前缀，足够独特）
  [publicKeyMarker(), '验签公钥内容'],
  ['catmax-hot-update/v1', '签名负载格式（验签逻辑）'],
]

function publicKeyMarker() {
  const pem = readFileSync(join(ROOT, 'src/bootstrap/public-key.mjs'), 'utf8')
  const m = /-----BEGIN PUBLIC KEY-----\s*([A-Za-z0-9+/=]+)/.exec(pem)
  if (!m) die('读不到 src/bootstrap/public-key.mjs 里的公钥，无法执行内容断言')
  return m[1].slice(0, 32)
}

for (const [marker, label] of CONTENT_MARKERS) {
  let hits = ''
  try {
    // grep -rl 找出包含特征串的文件；没命中时 grep 退出码为 1，execFileSync 会抛
    hits = execFileSync('grep', ['-rl', marker, stageDir], { encoding: 'utf8' }).trim()
  } catch {
    hits = ''
  }
  if (hits) {
    die(
      `安全断言失败：热更新包内出现了${label}（按内容匹配）\n` +
        hits
          .split('\n')
          .map((h) => `     ${h.slice(stageDir.length + 1)}`)
          .join('\n') +
        `\n   多半是有业务代码 import 了 src/bootstrap/ 下的模块，被 vite 内联进了产物。` +
        `\n   验签相关的一切必须留在 asar 内、永不参与热更新（设计文档 §8.4）。`,
    )
  }
}

console.log(`  • 断言通过：包内无 bootstrap / node_modules / 公钥 / 验签逻辑（含内容级检查）`)

// ---- 4. 打 tar 并签名 ----

// --no-xattrs / COPYFILE_DISABLE: macOS 的 bsdtar 默认会塞进 ._* AppleDouble 文件
// 和扩展属性，让同样的输入产出不同的字节，破坏可复现性。
execFileSync('tar', ['--no-xattrs', '-czf', tarball, '-C', stageDir, '.'], {
  env: { ...process.env, COPYFILE_DISABLE: '1' },
})
rmSync(stageDir, { recursive: true, force: true })

const bytes = readFileSync(tarball)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const size = statSync(tarball).size

const privateKey = createPrivateKey(readFileSync(keyPath))
const payload = signingPayload({ hotVersion, baseVersion, runtimeId, sha256 })
const signature = cryptoSign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64')

// ---- 5. manifest ----

const latest = {
  hotVersion,
  baseVersion,
  runtimeId,
  // url 不在签名负载里——签的是内容与版本，不是它放在哪。所以这里就能填好最终
  // 地址，上传步骤只做传输，不再改写 manifest 的任何受签名保护的字段。
  url: tarballUrl(baseVersion, hotVersion),
  size,
  sha256,
  signature,
  mandatory: false,
  releaseNotes: notes,
  releasedAt: new Date().toISOString(),
  commit,
}

// history 由 publish-hot.mjs 在上传成功后维护，这里原样继承已发布的那份。
const manifest = { schema: 1, channel: 'stable', latest, history: prev?.history ?? [] }

if (dryRun) {
  rmSync(tarball, { force: true })
  console.log('\n  --dry-run：已丢弃产物，manifest 未写入\n')
  console.log(JSON.stringify(manifest, null, 2))
  process.exit(0)
}

writeFileSync(PENDING, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`  • 打包  ${tarball}  (${(size / 1024 / 1024).toFixed(2)} MB)`)
console.log(`  • sha256 ${sha256}`)
console.log(`  • 签名  ${signature.slice(0, 32)}…`)
console.log(`  • 待发布 manifest → ${PENDING}`)

if (!has('publish')) {
  console.log(`\n✅ h${hotVersion} 已签名，**尚未发布**。上传：`)
  console.log(`   node scripts/publish-hot.mjs`)
  console.log(`   （或重跑本脚本时加 --publish 一次做完）`)
  process.exit(0)
}

console.log('')
execFileSync('node', [join(ROOT, 'scripts/publish-hot.mjs')], { stdio: 'inherit' })
