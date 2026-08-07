/**
 * Hot Update PoC / Phase 1 验收：在 userData 下手工布置热更新版本。
 *
 * 用法（必须先 pnpm build）：
 *   node poc/hot-update/prepare.cjs good <n>   # 布置一个能正常启动的 h<n> 并激活
 *   node poc/hot-update/prepare.cjs bad  <n>   # 布置一个「第一行就 throw」的坏包并激活
 *   node poc/hot-update/prepare.cjs state      # 打印当前 state.json
 *   node poc/hot-update/prepare.cjs off        # active=0，下次启动走 asar 内置
 *   node poc/hot-update/prepare.cjs clean      # 删掉整个 hot-updates 目录
 *
 * 好包会注入两处**肉眼可见**的标记，否则应用启动后一切正常，根本无法判断
 * 跑的是 asar 内置版本还是侧载版本：
 *   1. main/index.js 顶部 console.log  → 证明主进程侧载生效
 *   2. renderer/index.html 里的角标     → 证明渲染层也来自 userData
 *
 * 坏包用于 Phase 1 的验收（设计文档 §10）：连续启动失败两次后，bootstrap 必须
 * 自动退回 confirmed 版本。这一步必须在任何联网代码存在之前验证通过——
 * 否则一旦发出去就没有回头路。
 *
 * 注意 userData 是 ~/Library/Application Support/catmax-app：打包版和 dev 共用同一个
 * 目录（package.json 只有 name、没有 productName，app.getName() 因此返回 catmax-app）。
 * 这不影响验收——dev 模式不经过 bootstrap，读不到这里的 state.json。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../..')
const OUT = path.join(ROOT, 'out')

// 仅支持 macOS：第一期范围就是 mac（设计文档 §9.2）
const USER_DATA = path.join(os.homedir(), 'Library/Application Support/catmax-app')
const HOT_ROOT = path.join(USER_DATA, 'hot-updates')
const VERSIONS = path.join(HOT_ROOT, 'versions')
const STATE = path.join(HOT_ROOT, 'state.json')

const [, , mode, versionArg] = process.argv

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'))
  } catch {
    return null
  }
}

function writeState(next) {
  fs.mkdirSync(HOT_ROOT, { recursive: true })
  fs.writeFileSync(STATE, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`  • state.json → ${JSON.stringify(next)}`)
}

/** 与 scripts/compute-runtime-id.cjs 写进 out/bootstrap 的那份保持一致，否则会被守门作废 */
function hostRuntimeId() {
  try {
    return JSON.parse(fs.readFileSync(path.join(OUT, 'bootstrap/runtime-id.json'), 'utf8')).runtimeId
  } catch {
    throw new Error('读不到 out/bootstrap/runtime-id.json，请先跑 pnpm build')
  }
}

if (mode === 'clean') {
  fs.rmSync(HOT_ROOT, { recursive: true, force: true })
  console.log(`  • 已删除 ${HOT_ROOT}`)
  process.exit(0)
}

if (mode === 'state') {
  console.log(JSON.stringify(readState(), null, 2) ?? '(无 state.json)')
  process.exit(0)
}

if (mode === 'off') {
  const prev = readState() ?? {}
  writeState({ ...prev, active: 0 })
  console.log('  • 下次启动将走 asar 内置版本')
  process.exit(0)
}

if (mode !== 'good' && mode !== 'bad') {
  console.error('用法: prepare.cjs good|bad <n> | state | off | clean')
  process.exit(1)
}

const n = Number(versionArg)
if (!Number.isInteger(n) || n <= 0) {
  console.error('版本号必须是正整数，例如: prepare.cjs good 1')
  process.exit(1)
}

for (const sub of ['main', 'preload', 'renderer']) {
  if (!fs.existsSync(path.join(OUT, sub))) {
    throw new Error(`out/${sub} 不存在，请先跑 pnpm build`)
  }
}

const target = path.join(VERSIONS, `h${n}`)
fs.rmSync(target, { recursive: true, force: true })
fs.mkdirSync(target, { recursive: true })

for (const sub of ['main', 'preload', 'renderer']) {
  fs.cpSync(path.join(OUT, sub), path.join(target, sub), { recursive: true })
}

// Phase 0 实测：没有这个文件，侧载必定失败。
// .js 的模块类型由最近的 package.json 的 type 字段决定；userData 那棵目录树里
// 一个 package.json 都没有，Node 会按 CJS 解析，撞上顶层 import 直接 SyntaxError。
fs.writeFileSync(path.join(target, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`)

const mainFile = path.join(target, 'main/index.js')

if (mode === 'bad') {
  // 在**模块最顶部**抛错：这是最恶劣的失败模式——错误发生在 import 求值阶段，
  // 业务代码没有任何机会自救，只有 bootstrap 能兜住。
  fs.writeFileSync(
    mainFile,
    `throw new Error('[BAD-H${n}] 人为构造的坏包，用于验证自动回滚')\n`
  )
  console.log(`  • 已布置坏包 h${n}（main/index.js 第一行就 throw）`)
} else {
  const mainSrc = fs.readFileSync(mainFile, 'utf8')
  fs.writeFileSync(
    mainFile,
    `console.log('[HOT-H${n}] ★ 来自 userData/versions/h${n} 的 main，不是 asar 内置版本')\n${mainSrc}`
  )

  const htmlFile = path.join(target, 'renderer/index.html')
  const htmlSrc = fs.readFileSync(htmlFile, 'utf8')
  const badge = `<div style="position:fixed;z-index:2147483647;right:8px;bottom:8px;
background:#16a34a;color:#fff;font:12px/1.6 ui-monospace,monospace;
padding:4px 10px;border-radius:6px;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.3)">
HOT h${n} · from userData</div>`
  fs.writeFileSync(htmlFile, htmlSrc.replace('</body>', `${badge}\n</body>`))
  console.log(`  • 已布置好包 h${n}（含 main 标记与 renderer 角标）`)
}

const prev = readState()
writeState({
  baseVersion: require(path.join(ROOT, 'package.json')).version,
  runtimeId: hostRuntimeId(),
  active: n,
  confirmed: prev?.confirmed ?? 0,
  staged: null,
  bootAttempts: 0,
  lastCheckAt: Date.now(),
})
