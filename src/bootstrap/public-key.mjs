/**
 * Hot Update: 热更新包验签公钥。**由 scripts/generate-signing-key.cjs 生成，不要手改。**
 *
 * 它必须和验签逻辑一起待在 asar 内、且绝不进入热更新包（设计文档 §8.4）——
 * 一旦公钥或验签代码可以被热更新替换，攻击者只要投一个包就能把验签换成空实现，
 * 之后所有防护全部失效。scripts/release-hot.mjs 会在打包时主动断言这一点。
 *
 * 对应私钥离线保管，不在仓库里，也不在 CI 里。
 */
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAFxeplaHxzQ5RTz8BHjRtxUfnqQuRTgXncwarKCUJk+8=
-----END PUBLIC KEY-----`
