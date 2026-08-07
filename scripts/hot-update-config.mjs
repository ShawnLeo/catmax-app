/**
 * Hot Update: 发布侧的基础设施常量（设计文档 §9.5）。
 *
 * 单独成文件的唯一理由是**防漂移**：`release-hot.mjs` 要拼公网 URL 写进 manifest，
 * `publish-hot.mjs` 要拼 R2 object key 做上传，两者必须指向同一个对象。分别写死
 * 是最容易出的一类错——URL 与 key 差一个前缀，manifest 会指向一个 404，而发布
 * 脚本自己完全看不出异常。
 *
 * 客户端**不使用**本文件：它只从 manifest 的 `url` 字段取地址。所以改这里不需要
 * 发新的完整安装包，但会让新老 manifest 指向不同路径，旧包必须保留（§6.6）。
 */

/** R2 bucket 名。account 级 token 只能操作 R2，见 §9.5 的能力边界实测 */
export const BUCKET = 'catmax-updates'

/** bucket 内的 key 前缀（无前导斜杠）。与 PUBLIC_BASE 的路径部分必须一致 */
export const KEY_PREFIX = 'catmax/hot'

/**
 * 公网基址。必须是自定义域——`r2.dev` 被官方限速且仅供开发使用（§6.6），
 * 不能用于生产分发。
 */
export const PUBLIC_BASE = 'https://hot.toolpie.dev/catmax/hot'

/**
 * 旧包保留策略（§6.6）。**不是为了省存储**——热更新包只占免费额度的 0.5%，
 * 删了一分钱省不下。它服务的是服务端紧急下架：h5 是坏包时的处置方式是把
 * manifest 改回指向 h4，此时 h4 的 tar.gz 必须还在 R2 上。删太狠会让这个
 * 动作直接失效。
 */
export const KEEP_RECENT = 10
export const KEEP_MIN = 3

export function tarballKey(baseVersion, hotVersion) {
  return `${KEY_PREFIX}/${baseVersion}/h${hotVersion}.tar.gz`
}

export function tarballUrl(baseVersion, hotVersion) {
  return `${PUBLIC_BASE}/${baseVersion}/h${hotVersion}.tar.gz`
}

export const MANIFEST_KEY = `${KEY_PREFIX}/manifest.json`
export const MANIFEST_URL = `${PUBLIC_BASE}/manifest.json`

/**
 * 从已发布版本账本里挑出可以从 R2 删除的版本（降序）。
 *
 * 单独抽成纯函数是因为**这个判断错了不可逆**：删掉 manifest 当前指向的包，等于
 * 全体客户端下载 404，且服务端再也无法把 manifest 改回该版本做紧急下架（§6.6）。
 * 嵌在上传脚本里就只能靠人眼审，而它的正常路径（版本数不足 KEEP_RECENT）根本
 * 不会执行到删除分支——真出问题时已经发出去了。
 *
 * 注意与 `src/bootstrap/state-machine.mjs` 的 `versionsToPrune` 区分：那个清理的是
 * **客户端本地** `versions/` 目录，读的是本地磁盘、保护的是回滚能力；这个清理的是
 * **R2 上的远端包**，保护的是服务端下架能力。两者互不影响（§6.6 末尾）。
 *
 * @param {number[]} history 已发布的 hotVersion 列表
 * @param {number} current manifest 当前指向的 hotVersion，永不删除
 * @returns {number[]} 应删除的版本，降序
 */
export function remoteVersionsToPrune(history, current) {
  const prunable = [...new Set(history)].filter((v) => v !== current).sort((a, b) => b - a)
  // 保留 KEEP_RECENT 个（含 current），因此 prunable 侧保留 KEEP_RECENT - 1 个；
  // KEEP_MIN 是硬下限，防止有人把 KEEP_RECENT 调小到让下架能力消失。
  return prunable.slice(Math.max(KEEP_RECENT - 1, KEEP_MIN - 1))
}
