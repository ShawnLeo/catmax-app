/**
 * Hot Update: 把 `release-hot.mjs` 签好的包上传到 R2（设计文档 §9.1、§9.5）。
 *
 *   node scripts/publish-hot.mjs            # 上传 release/manifest.pending.json 指向的版本
 *   node scripts/publish-hot.mjs --dry-run  # 只打印将要执行的命令
 *
 * **为什么与 release-hot.mjs 分开、而不是合成一个脚本**：两者的失败语义相反。
 * 签名那四步要么全对要么整个作废（漏一条断言就是静默掏空验签，§8.4），所以它
 * 必须一次跑完；而上传是网络操作，失败是常态，必须能原地重试任意多次而不改变
 * 任何已签名的字节。合成一个脚本就得在"重跑"时决定要不要重新打包——而重新打包
 * 会换掉 sha256，让"重试上传"变成"发布另一个包"。
 *
 * 顺序是死的（§9.1）：**tar.gz 先传并验证公网可读，manifest 最后传。** 反过来会
 * 有一个窗口，客户端拿到的 manifest 指向一个 404 的 URL。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BUCKET,
  KEEP_RECENT,
  MANIFEST_KEY,
  MANIFEST_URL,
  remoteVersionsToPrune,
  tarballKey,
  tarballUrl,
} from './hot-update-config.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE_DIR = join(ROOT, 'release')
const MANIFEST = join(RELEASE_DIR, 'manifest.json')
const PENDING = join(RELEASE_DIR, 'manifest.pending.json')

const dryRun = process.argv.includes('--dry-run')

function die(msg) {
  console.error(`\n❌ ${msg}\n`)
  process.exit(1)
}

// ---- 1. 前置检查 ----

if (!existsSync(PENDING)) {
  die(
    `没有待发布的版本（${PENDING} 不存在）。\n` +
      `   先跑：pnpm build && node scripts/release-hot.mjs --notes "..."`,
  )
}

const manifest = JSON.parse(readFileSync(PENDING, 'utf8'))
const { latest } = manifest
const tarball = join(RELEASE_DIR, `h${latest.hotVersion}.tar.gz`)

if (!existsSync(tarball)) die(`找不到 ${tarball}，请重新跑 release-hot.mjs`)

// manifest 里的 sha256 是被签名保护的，而 tar.gz 是一个独立的本地文件——两者对不上
// 说明包在签名之后被改过（手动替换、磁盘损坏、或改错了文件）。此时上传等于发布一个
// 客户端**必定验签失败**的版本：所有人都下载、全部拒绝、然后不断重试。
const actualSha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
if (actualSha256 !== latest.sha256) {
  die(
    `tar.gz 与 manifest 的 sha256 不一致，拒绝上传。\n` +
      `   manifest: ${latest.sha256}\n` +
      `   实际:     ${actualSha256}\n` +
      `   包在签名之后被改动过，请重新跑 release-hot.mjs。`,
  )
}

// wrangler 的凭据优先级是 CLOUDFLARE_API_TOKEN > ~/.wrangler 的 OAuth。OAuth 登录
// 拿到的是**账号全权**凭据（能删 bucket、改 DNS、部署 Worker），发布脚本不该持有
// 这种权限——它只需要写一个 bucket。所以这里硬性要求 scoped token，宁可失败也不
// 静默降级到 OAuth（§9.5）。
//
// **token 必须放在 ~/.zshenv，不是 ~/.zshrc**：zshrc 只在交互式 shell 加载，
// `zsh -c`/脚本/agent/CI 都读不到，会走到这里 die。zshenv 是 zsh 所有调用
// （交互/非交互/登录/脚本）都加载的唯一 rc 文件。
if (!process.env.CLOUDFLARE_API_TOKEN) {
  die(
    `未设置 CLOUDFLARE_API_TOKEN。\n` +
      `   不会回退到 wrangler 的 OAuth 登录——那是账号全权凭据，发布脚本只应持有\n` +
      `   仅能写 R2 的 scoped token（设计文档 §9.5）。\n\n` +
      `   把它放进 ~/.zshenv（不是 ~/.zshrc——zshrc 非交互 shell 读不到）：\n` +
      `     export CLOUDFLARE_API_TOKEN="..."\n` +
      `   或显式传入：CLOUDFLARE_API_TOKEN=... node scripts/publish-hot.mjs\n` +
      `   CI 环境用 secret 注入，不要写进任何 rc 文件。`,
  )
}

// ---- 2. 上传 ----

const key = tarballKey(latest.baseVersion, latest.hotVersion)
const url = tarballUrl(latest.baseVersion, latest.hotVersion)

if (latest.url !== url) {
  die(`manifest 的 url 与配置推出的地址不一致：\n   ${latest.url}\n   ${url}`)
}

function wrangler(args) {
  if (dryRun) {
    console.log(`  [dry-run] wrangler ${args.join(' ')}`)
    return
  }
  execFileSync('wrangler', args, { stdio: ['ignore', 'pipe', 'inherit'] })
}

function put(objectPath, file, contentType, cacheControl) {
  // -y 跳过 data catalog 校验提示：不加的话非交互环境会挂在等待输入上。
  // --remote 不能省——wrangler 默认写本地 .wrangler/state，看起来成功但什么都没上传。
  wrangler([
    'r2',
    'object',
    'put',
    objectPath,
    '--file',
    file,
    '--remote',
    '-y',
    '--content-type',
    contentType,
    '--cache-control',
    cacheControl,
  ])
}

console.log(`  • 上传 h${latest.hotVersion} → ${BUCKET}/${key}`)
// tar.gz 是内容寻址的（文件名含版本号，内容永不变），可以让边缘和客户端永久缓存。
put(`${BUCKET}/${key}`, tarball, 'application/gzip', 'public, max-age=31536000, immutable')

// ---- 3. 验证包已公网可读，之后才动 manifest ----

async function head(target) {
  const res = await fetch(target, { method: 'HEAD', cache: 'no-store' })
  return { status: res.status, length: Number(res.headers.get('content-length') ?? 0) }
}

if (!dryRun) {
  const probe = await head(url)
  if (probe.status !== 200) {
    die(
      `包已上传但公网读不到（HTTP ${probe.status}）：${url}\n` +
        `   manifest 未更新，线上仍是上一个版本——这正是"manifest 最后传"要保护的情况。\n` +
        `   检查自定义域绑定（§9.5）后重跑本脚本即可。`,
    )
  }
  if (probe.length !== latest.size) {
    die(`公网返回的大小与 manifest 不符：${probe.length} ≠ ${latest.size}`)
  }
  console.log(`  ✓ 公网可读，大小一致（${probe.length} bytes）`)
}

// ---- 4. 更新 history 并上传 manifest ----

const history = [...new Set([...(manifest.history ?? []), latest.hotVersion])].sort((a, b) => a - b)
const finalManifest = { ...manifest, history }
if (!dryRun) writeFileSync(PENDING, `${JSON.stringify(finalManifest, null, 2)}\n`)

console.log(`  • 上传 manifest → ${BUCKET}/${MANIFEST_KEY}`)
// max-age=300 与 §6.6 的成本模型绑定：轮询间隔是 4 小时，缓存 5 分钟只挡住重复启动，
// 不影响额度估算。改大会推迟用户拿到新版本的时间，改小没有收益。
put(`${BUCKET}/${MANIFEST_KEY}`, PENDING, 'application/json', 'public, max-age=300')

if (!dryRun) {
  const res = await fetch(MANIFEST_URL, { cache: 'no-store' })
  if (!res.ok) die(`manifest 上传后读回失败：HTTP ${res.status}`)
  const live = await res.json()
  if (live.latest?.sha256 !== latest.sha256 || live.latest?.hotVersion !== latest.hotVersion) {
    die(
      `线上 manifest 与本地不一致，疑似上传到了别的对象：\n${JSON.stringify(live.latest, null, 2)}`,
    )
  }
  console.log(`  ✓ 线上 manifest 已指向 h${latest.hotVersion}`)
}

// ---- 5. pending → manifest.json（本地状态推进）----

if (!dryRun) {
  renameSync(PENDING, MANIFEST)
  console.log(`  ✓ ${MANIFEST}（已发布状态）`)
}

// ---- 6. 清理旧包 ----

// wrangler 4.119 **没有 `r2 object list`**（只有 get/put/delete），所以远端有哪些包
// 无法枚举，只能靠账本。账本存在 manifest 的 `history` 里而不是本地文件，是因为
// release/ 在 .gitignore 内：本地目录一旦丢失，存在本地的账本会连同清理能力一起消失，
// 而 manifest 在 R2 上有权威副本，随时能拉回来重建。
const toDelete = remoteVersionsToPrune(history, latest.hotVersion)

if (toDelete.length > 0) {
  console.log(`  • 清理 ${toDelete.length} 个旧包（保留最近 ${KEEP_RECENT} 个）`)
  const kept = history.filter((v) => !toDelete.includes(v))
  for (const v of toDelete) {
    // 双保险：绝不删 manifest 当前指向的版本。删掉它 = 所有客户端下载 404，
    // 且服务端再也无法把 manifest 改回这个版本做紧急下架（§6.6）。
    if (v === latest.hotVersion) continue
    wrangler([
      'r2',
      'object',
      'delete',
      `${BUCKET}/${tarballKey(latest.baseVersion, v)}`,
      '--remote',
      '-y',
    ])
    console.log(`    - h${v}`)
  }
  if (!dryRun) {
    writeFileSync(MANIFEST, `${JSON.stringify({ ...finalManifest, history: kept }, null, 2)}\n`)
    // 本地账本变了，线上那份还写着已删除的版本。重传一次让两边一致——此时包已
    // 就位、manifest 内容除 history 外未变，不存在 §9.1 的窗口问题。
    put(`${BUCKET}/${MANIFEST_KEY}`, MANIFEST, 'application/json', 'public, max-age=300')
  }
}

if (dryRun) {
  console.log('\n  --dry-run：以上命令均未执行，本地文件未改动\n')
  process.exit(0)
}

console.log(`\n✅ h${latest.hotVersion} 已发布`)
console.log(`   manifest: ${MANIFEST_URL}`)
console.log(`   包:       ${url}`)
