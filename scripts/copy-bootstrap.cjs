/**
 * Hot Update: 把 src/bootstrap/ 原样复制到 out/bootstrap/。
 *
 * 为什么是复制而不是让 electron-vite 构建它（见设计文档 §5.3、§8.4）：
 * bootstrap 里将来要放验签逻辑和硬编码公钥，它必须待在 asar 内且**不能**出现在
 * 热更新包里。一旦交给 vite，它会被打进 out/main/index.js —— 而那正是热更新要
 * 替换的文件，等于把公钥交给攻击者替换。
 *
 * 必须在 `electron-vite build` **之后**跑：vite 会清空 outDir。
 *
 * 另一个约束来自 electron-builder.yml 的 files 白名单（只收 out/、resources/、
 * package.json），所以产物只能落在 out/ 下面，不能自立门户。
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'src/bootstrap')
const DEST = path.join(ROOT, 'out/bootstrap')

if (!fs.existsSync(SRC)) {
  throw new Error(`copy-bootstrap: 源目录不存在 ${SRC}`)
}
if (!fs.existsSync(path.join(ROOT, 'out'))) {
  throw new Error('copy-bootstrap: out/ 不存在，请先跑 electron-vite build')
}

fs.rmSync(DEST, { recursive: true, force: true })
// 排除 .d.mts：类型声明只服务于 tests/ 的 import，运行时用不到，
// 没有理由占 asar 的体积。
fs.cpSync(SRC, DEST, {
  recursive: true,
  filter: (src) => !src.endsWith('.d.mts'),
})

const copied = fs.readdirSync(DEST)
console.log(`  • copy-bootstrap: ${SRC} → ${DEST}（${copied.join(', ')}）`)
