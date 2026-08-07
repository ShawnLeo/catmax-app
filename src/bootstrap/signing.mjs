/**
 * Hot Update: 签名负载的规范化与验签。
 *
 * 这个文件同时被两侧使用——发布脚本（签名）和 bootstrap（验签）。让它们共用
 * 同一个 `signingPayload()` 是刻意的：两侧各写一份"拼接待签字符串"的代码，
 * 迟早会因为字段顺序或分隔符不一致而漂移，表现为"签名明明是对的却验不过"，
 * 而这种故障极难排查。
 *
 * **签的不只是 sha256。** 设计文档 §6.3 原本只提"对 sha256 值做签名"，但那样
 * 攻击者可以把一个合法签名的包重新挂到别的 hotVersion / baseVersion 下：
 * 例如把旧的、有已知漏洞的 h3 包伪装成 h9 推给用户，sha256 和签名都是真的。
 * 所以把所有安全相关字段一起纳入签名负载。
 *
 * 它属于 asar 内不可热更新的部分（§8.4）。
 */

/** 负载格式版本。将来若要增删字段，靠它区分，避免老客户端误判。 */
export const SIGNING_SCHEMA = 'catmax-hot-update/v1'

/**
 * 把一次发布的安全相关字段规范化成待签字符串。
 *
 * 字段顺序固定、逐行拼接，不用 JSON——JSON 的键顺序和空白在不同实现下不稳定，
 * 而签名对字节级差异零容忍。
 */
export function signingPayload({ hotVersion, baseVersion, runtimeId, sha256 }) {
  return [
    SIGNING_SCHEMA,
    `hotVersion:${hotVersion}`,
    `baseVersion:${baseVersion}`,
    `runtimeId:${runtimeId}`,
    `sha256:${sha256}`,
  ].join('\n')
}

/**
 * 验签。
 *
 * @param {object} crypto  node:crypto（由调用方注入，方便测试）
 * @param {string} publicKeyPem
 * @param {object} fields  {hotVersion, baseVersion, runtimeId, sha256}
 * @param {string} signatureBase64
 * @returns {boolean}
 */
export function verifySignature(crypto, publicKeyPem, fields, signatureBase64) {
  try {
    return crypto.verify(
      null, // Ed25519 不需要单独指定摘要算法
      Buffer.from(signingPayload(fields), 'utf8'),
      publicKeyPem,
      Buffer.from(signatureBase64, 'base64')
    )
  } catch {
    // 签名格式非法、公钥损坏等一律按验签失败处理，绝不放行
    return false
  }
}

/**
 * 安装前的完整校验（§5.8）。
 *
 * 返回 `{ok:true}` 或 `{ok:false, reason, poisoned}`。`poisoned` 区分两类失败：
 * 传输损坏可以重下一次，而验签失败 / 版本回退是**投毒信号**，必须停止本轮更新
 * 并记录，绝不能像 sha256 那样"重试一次"。
 */
export function checkUpdate(crypto, publicKeyPem, manifest, actualSha256, host) {
  const { hotVersion, baseVersion, runtimeId, sha256, signature } = manifest

  if (actualSha256 !== sha256) {
    return { ok: false, reason: `sha256 不匹配（期望 ${sha256}，实际 ${actualSha256}）`, poisoned: false }
  }

  // §8.2 单调递增：否则攻击者可以重放一个有已知漏洞的旧包（回滚攻击）
  if (!(Number(hotVersion) > Number(host.currentHotVersion))) {
    return {
      ok: false,
      reason: `hotVersion ${hotVersion} 未大于当前 ${host.currentHotVersion}，拒绝回滚`,
      poisoned: true,
    }
  }

  if (baseVersion !== host.appVersion) {
    return { ok: false, reason: `baseVersion ${baseVersion} ≠ 宿主 ${host.appVersion}`, poisoned: false }
  }

  if (runtimeId !== host.runtimeId) {
    return { ok: false, reason: `runtimeId ${runtimeId} ≠ 宿主 ${host.runtimeId}`, poisoned: false }
  }

  if (!verifySignature(crypto, publicKeyPem, { hotVersion, baseVersion, runtimeId, sha256 }, signature)) {
    return { ok: false, reason: 'Ed25519 验签失败', poisoned: true }
  }

  return { ok: true }
}
