/**
 * Hot Update: signing.mjs 的类型声明。手写理由同 state-machine.d.mts——
 * bootstrap 故意不经过任何构建（设计文档 §5.3）。
 */

export interface SigningFields {
  hotVersion: number
  baseVersion: string
  runtimeId: string
  sha256: string
}

export interface UpdateManifestEntry extends SigningFields {
  signature: string
  url?: string
  size?: number
  mandatory?: boolean
  releaseNotes?: string
  releasedAt?: string
}

export interface HostFacts {
  appVersion: string
  runtimeId: string
  currentHotVersion: number
}

export type UpdateCheckResult =
  | { ok: true }
  | {
      ok: false
      reason: string
      /** true = 投毒信号（验签失败/版本回退），必须停止本轮更新并记录，不可重试 */
      poisoned: boolean
    }

export const SIGNING_SCHEMA: string

export function signingPayload(fields: SigningFields): string

export function verifySignature(
  crypto: typeof import('node:crypto'),
  publicKeyPem: string,
  fields: SigningFields,
  signatureBase64: string
): boolean

export function checkUpdate(
  crypto: typeof import('node:crypto'),
  publicKeyPem: string,
  manifest: UpdateManifestEntry,
  actualSha256: string,
  host: HostFacts
): UpdateCheckResult
