/**
 * Hot Update: 签名与安装前校验的单测。
 *
 * 这一层是热更新的安全边界（设计文档 §8）：热更新绕过了操作系统的代码签名去执行
 * 远程代码，而 catmax 有 pty、完整文件系统访问和用户的 API key。所以这里的重点
 * 不是 happy path，而是**每一种应该被拒绝的输入都确实被拒绝了**。
 */
import crypto from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { checkUpdate, signingPayload, verifySignature } from '../../src/bootstrap/signing.mjs'

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const PUB = publicKey.export({ type: 'spki', format: 'pem' }) as string

const HOST = { appVersion: '0.1.0', runtimeId: 'abc123def456', currentHotVersion: 3 }

function sign(fields: Parameters<typeof signingPayload>[0]): string {
  return crypto
    .sign(null, Buffer.from(signingPayload(fields), 'utf8'), privateKey)
    .toString('base64')
}

function manifest(patch: Record<string, unknown> = {}) {
  const fields = {
    hotVersion: 4,
    baseVersion: '0.1.0',
    runtimeId: 'abc123def456',
    sha256: 'a'.repeat(64),
    ...patch,
  }
  return { ...fields, signature: sign(fields as never) }
}

describe('signingPayload', () => {
  it('字段顺序固定，可复现', () => {
    const f = { hotVersion: 4, baseVersion: '0.1.0', runtimeId: 'rid', sha256: 'sha' }
    expect(signingPayload(f)).toBe(signingPayload({ ...f }))
    expect(signingPayload(f)).toMatch(/^catmax-hot-update\/v1\n/)
  })

  it('任一字段变化都会改变待签内容', () => {
    const base = { hotVersion: 4, baseVersion: '0.1.0', runtimeId: 'rid', sha256: 'sha' }
    expect(signingPayload({ ...base, hotVersion: 5 })).not.toBe(signingPayload(base))
    expect(signingPayload({ ...base, runtimeId: 'other' })).not.toBe(signingPayload(base))
  })
})

describe('verifySignature', () => {
  it('接受合法签名', () => {
    const f = { hotVersion: 4, baseVersion: '0.1.0', runtimeId: 'rid', sha256: 'sha' }
    expect(verifySignature(crypto, PUB, f, sign(f))).toBe(true)
  })

  it('拒绝被篡改的字段', () => {
    const f = { hotVersion: 4, baseVersion: '0.1.0', runtimeId: 'rid', sha256: 'sha' }
    const sig = sign(f)
    expect(verifySignature(crypto, PUB, { ...f, hotVersion: 9 }, sig)).toBe(false)
    expect(verifySignature(crypto, PUB, { ...f, sha256: 'tampered' }, sig)).toBe(false)
  })

  it('拒绝别的密钥签出来的签名', () => {
    const other = crypto.generateKeyPairSync('ed25519')
    const f = { hotVersion: 4, baseVersion: '0.1.0', runtimeId: 'rid', sha256: 'sha' }
    const rogue = crypto
      .sign(null, Buffer.from(signingPayload(f), 'utf8'), other.privateKey)
      .toString('base64')
    expect(verifySignature(crypto, PUB, f, rogue)).toBe(false)
  })

  it('签名格式非法时返回 false 而不是抛异常', () => {
    const f = { hotVersion: 4, baseVersion: '0.1.0', runtimeId: 'rid', sha256: 'sha' }
    expect(verifySignature(crypto, PUB, f, 'not-base64-@@@')).toBe(false)
    expect(verifySignature(crypto, PUB, f, '')).toBe(false)
  })
})

describe('checkUpdate', () => {
  it('接受一个各方面都合法的更新', () => {
    expect(checkUpdate(crypto, PUB, manifest(), 'a'.repeat(64), HOST)).toEqual({ ok: true })
  })

  it('sha256 不匹配 → 传输损坏，可重试', () => {
    const r = checkUpdate(crypto, PUB, manifest(), 'b'.repeat(64), HOST)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.poisoned).toBe(false)
  })

  it('hotVersion 未递增 → 回滚攻击，标记为投毒', () => {
    const r = checkUpdate(crypto, PUB, manifest({ hotVersion: 3 }), 'a'.repeat(64), HOST)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.poisoned).toBe(true)
  })

  it('hotVersion 更旧 → 同样拒绝', () => {
    const r = checkUpdate(crypto, PUB, manifest({ hotVersion: 1 }), 'a'.repeat(64), HOST)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.poisoned).toBe(true)
  })

  it('baseVersion 不符 → 拒绝，但不算投毒', () => {
    const r = checkUpdate(crypto, PUB, manifest({ baseVersion: '0.2.0' }), 'a'.repeat(64), HOST)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.poisoned).toBe(false)
  })

  it('runtimeId 不符 → 拒绝（native 环境不兼容）', () => {
    const r = checkUpdate(
      crypto,
      PUB,
      manifest({ runtimeId: 'different123' }),
      'a'.repeat(64),
      HOST,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.poisoned).toBe(false)
  })

  it('签名被替换 → 投毒', () => {
    const m = { ...manifest(), signature: sign({ ...manifest(), hotVersion: 99 } as never) }
    const r = checkUpdate(crypto, PUB, m, 'a'.repeat(64), HOST)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.poisoned).toBe(true)
  })

  it('合法签名的旧包被重新挂到新 hotVersion 下 → 拒绝', () => {
    // 攻击场景：拿一个真实签过名的 h4 包，把 manifest 里的 hotVersion 改成 9
    // 想让已经在 h8 的用户装上这个有已知漏洞的旧包。签名覆盖了 hotVersion，所以验不过。
    const real = manifest({ hotVersion: 4 })
    const forged = { ...real, hotVersion: 9 }
    const r = checkUpdate(crypto, PUB, forged, 'a'.repeat(64), {
      ...HOST,
      currentHotVersion: 8,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.poisoned).toBe(true)
  })
})
