/**
 * Hot Update: 计算 native 环境指纹 runtimeId，写到 out/bootstrap/runtime-id.json。
 *
 * 它挡的是这类事故（设计文档 §4.3、§7.3）：热更新的 JS 调用了新版 better-sqlite3
 * 的 API，但用户机器上的 .node 还是旧的 → 加载即崩，且崩在业务代码里，回滚之外
 * 没有别的救法。运行时 bootstrap 比对宿主指纹与 state.json 里记录的指纹，
 * 不一致就直接作废全部热更新。
 *
 * 为什么不用版本号区间（minAppVersion/maxAppVersion）表达：native 依赖可以在宿主
 * 版本号不变的情况下变化（改个 dependency 重新打包），反过来宿主版本号变了 native
 * 也可能完全没动。一个显式指纹比版本区间更准确，也更难写错。
 *
 * **必须写在 out/bootstrap/ 而不是 out/main/** —— 后者会被热更新整个替换掉，
 * 一个能被热更新包自己改写的指纹起不到任何守门作用。
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const OUT_BOOTSTRAP = path.join(ROOT, 'out/bootstrap')

/**
 * 参与指纹的依赖：只有**无法 bundle、由宿主 asar 提供**的那些才算数。
 * 纯 JS 依赖已经被打进热更新包里自带（§5.10），换了也不会和宿主冲突，
 * 把它们算进来只会让指纹无谓地频繁变化、白白作废可用的热更新。
 */
const RUNTIME_DEPS = ['better-sqlite3', 'node-pty', '@anthropic-ai/claude-agent-sdk']

/**
 * 直接读 node_modules 下的 package.json，不用 require.resolve。
 *
 * require.resolve('<pkg>/package.json') 会被现代包的 `exports` 字段挡住——
 * claude-agent-sdk 就没有导出 './package.json'，实测返回 missing。
 * 那会让 SDK 升级时指纹纹丝不动，正好放过 runtimeId 本来要挡的那类事故。
 */
function resolvedVersion(name) {
  const pkgPath = path.join(ROOT, 'node_modules', name, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    throw new Error(
      `compute-runtime-id: 找不到 ${name} 的 package.json（${pkgPath}）。` +
        `指纹漏掉一项比构建失败危险得多——它会让 native 环境变化悄悄通过守门。`
    )
  }
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version
}

function computeRuntimeId() {
  const electronVersion = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'node_modules/electron/package.json'), 'utf8')
  ).version

  const parts = [
    `electron@${electronVersion}`,
    ...RUNTIME_DEPS.map((name) => `${name}@${resolvedVersion(name)}`).sort(),
  ]
  const input = parts.join('|')
  const runtimeId = crypto.createHash('sha256').update(input).digest('hex').slice(0, 12)
  return { runtimeId, input, parts }
}

const { runtimeId, input, parts } = computeRuntimeId()

if (!fs.existsSync(OUT_BOOTSTRAP)) {
  throw new Error('compute-runtime-id: out/bootstrap 不存在，请先跑 scripts/copy-bootstrap.cjs')
}

fs.writeFileSync(
  path.join(OUT_BOOTSTRAP, 'runtime-id.json'),
  `${JSON.stringify({ runtimeId, computedFrom: parts, computedAt: new Date().toISOString() }, null, 2)}\n`
)

console.log(`  • runtime-id: ${runtimeId}  ←  ${input}`)

module.exports = { computeRuntimeId }
