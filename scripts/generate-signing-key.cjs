/**
 * Hot Update: 生成热更新签名用的 Ed25519 密钥对。
 *
 * 只需要跑一次。之后每次发布用私钥签名，客户端用硬编码在 bootstrap 里的公钥验签。
 *
 * 为什么这件事必须做对（设计文档 §8.1）：热更新等于**绕过操作系统的代码签名机制
 * 去执行远程代码**，而 catmax 拥有 pty（任意命令执行）、完整文件系统访问、用户的
 * API key 与 ~/.codex/auth.json 的编辑能力。更新服务器被攻破 = 全部用户机器被 RCE。
 * 这不是夸张假设，是这个方案引入的真实攻击面，只能用密码学而不是运维纪律来兜底。
 *
 *   node scripts/generate-signing-key.cjs [私钥输出路径]
 *
 * 默认写到 ~/.catmax/hot-update-signing-key.pem（0600）。
 *
 * 公钥会被写进 src/bootstrap/public-key.mjs 并**提交进仓库**——它必须和验签逻辑
 * 一起待在 asar 内。私钥则**永远不要**提交、不要放进 CI 环境变量、不要贴进聊天记录。
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const PUBLIC_KEY_MODULE = path.join(ROOT, 'src/bootstrap/public-key.mjs')
const DEFAULT_PRIVATE_KEY = path.join(os.homedir(), '.catmax/hot-update-signing-key.pem')

const privateKeyPath = process.argv[2] ?? DEFAULT_PRIVATE_KEY

if (fs.existsSync(privateKeyPath)) {
  // 覆盖私钥 = 作废所有已发布的热更新，且老客户端再也验不过新包。
  // 这个操作没有撤销键，所以宁可让脚本失败。
  throw new Error(
    `私钥已存在：${privateKeyPath}\n` +
      `覆盖它会让所有已发布的热更新包验签失败，且无法恢复。\n` +
      `确实要换密钥的话，先手动备份并删除该文件，再重新跑本脚本——` +
      `注意换密钥后必须发一个完整安装包，才能把新公钥送到用户手上。`
  )
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')

const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' })
const publicPem = publicKey.export({ type: 'spki', format: 'pem' })

fs.mkdirSync(path.dirname(privateKeyPath), { recursive: true })
fs.writeFileSync(privateKeyPath, privatePem, { mode: 0o600 })
// writeFileSync 的 mode 只在**创建**文件时生效，已存在则不改权限。
// 上面已经保证了文件不存在，这里再 chmod 一次是防御性的。
fs.chmodSync(privateKeyPath, 0o600)

fs.writeFileSync(
  PUBLIC_KEY_MODULE,
  `/**
 * Hot Update: 热更新包验签公钥。**由 scripts/generate-signing-key.cjs 生成，不要手改。**
 *
 * 它必须和验签逻辑一起待在 asar 内、且绝不进入热更新包（设计文档 §8.4）——
 * 一旦公钥或验签代码可以被热更新替换，攻击者只要投一个包就能把验签换成空实现，
 * 之后所有防护全部失效。scripts/release-hot.mjs 会在打包时主动断言这一点。
 *
 * 对应私钥离线保管，不在仓库里，也不在 CI 里。
 */
export const UPDATE_PUBLIC_KEY = \`${publicPem.trimEnd()}\`
`
)

console.log(`  • 私钥 → ${privateKeyPath}  (0600，**不要提交、不要进 CI**)`)
console.log(`  • 公钥 → ${PUBLIC_KEY_MODULE}  (需要提交进仓库)`)
console.log('')
console.log('  请立刻把私钥备份到密码管理器或离线介质。')
console.log('  丢失私钥 = 再也无法发布热更新，只能发完整安装包换掉内置公钥。')
