/**
 * Hot Update: 展示自上次发布以来的 git 改动，供人 / Agent 判断这次该不该发、
 * 以及提炼 release notes 用。
 *
 *   node scripts/show-hot-changes.mjs
 *
 * 只读，不联网写入、不需要先 pnpm build，可以在决定要不要发布之前先跑一次。
 *
 * 取数源是 **R2 上的公网 manifest**，不是本地 `release/manifest.json`——后者整个
 * `release/` 目录是 gitignored 的，只存在于发布过的那台机器上；换一台机器或者
 * 别人接手发布，本地文件根本不在。公网 manifest 记的是"用户手上实际是哪个版本"，
 * 与在哪台机器发布无关，所以才是跨机器都对的锚点（release-hot.mjs 在打包时把
 * 当时的 git commit 写进 manifest.latest.commit，随包一起发布）。
 */
import { execFileSync } from 'node:child_process'

import { MANIFEST_URL } from './hot-update-config.mjs'

function die(msg) {
  console.error(`\n❌ ${msg}\n`)
  process.exit(1)
}

let manifest
try {
  const res = await fetch(MANIFEST_URL, { cache: 'no-store' })
  if (res.status === 404) {
    console.log('线上还没有任何 manifest（第一次发布，或者 R2 刚被清空过）。')
    console.log('没有可比较的上一个版本，这次的 release notes 直接从这次改动本身来写就行。')
    process.exit(0)
  }
  if (!res.ok) die(`拉取 manifest 失败：HTTP ${res.status} ${MANIFEST_URL}`)
  manifest = await res.json()
} catch (err) {
  die(`拉取 manifest 失败：${err?.message ?? err}`)
}

const prevCommit = manifest?.latest?.commit
if (!prevCommit) {
  console.log('线上 manifest 里没有 commit 记录（是本字段引入之前发的那个版本）。')
  console.log('无法自动算出改动范围，这次的 release notes 需要人工判断。')
  process.exit(0)
}

try {
  execFileSync('git', ['cat-file', '-e', `${prevCommit}^{commit}`], { stdio: 'ignore' })
} catch {
  console.log(`线上记录的 commit ${prevCommit} 在本地仓库里找不到（shallow clone？还没 fetch？）。`)
  console.log('先 `git fetch` 补全历史，或者人工判断这次改动范围。')
  process.exit(0)
}

console.log(`上次发布 h${manifest.latest.hotVersion}，对应 commit ${prevCommit.slice(0, 12)}`)
if (manifest.latest.releaseNotes) {
  console.log(`  上次的 release notes：${manifest.latest.releaseNotes}`)
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (head === prevCommit) {
  console.log('\nHEAD 与上次发布的 commit 相同，自上次发布以来没有新提交。')
  process.exit(0)
}

console.log(`\n自 ${prevCommit.slice(0, 12)} 以来的提交：\n`)
const log = execFileSync('git', ['log', '--oneline', `${prevCommit}..HEAD`], {
  encoding: 'utf8',
}).trim()
console.log(log || '（没有可比较的提交——可能上次发布之后发生过 rebase / history rewrite）')

const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
if (dirty) {
  console.log('\n⚠️ 工作区还有未提交改动，不在上面的提交列表里，但 pnpm build 会把它们一起打进包：')
  console.log(dirty)
}
