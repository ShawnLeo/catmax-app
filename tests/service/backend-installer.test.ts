// @vitest-environment node
import { describe, expect, test, vi } from 'vitest'

// backend-installer 在模块顶层 import electron（net/session/app），
// vitest 里没有 Electron runtime，mock 掉才能 import 到纯函数。
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  net: { request: () => ({}) },
  session: { fromPartition: () => ({ setProxy: async () => {} }) },
}))

const { parseAliasVersion, parseSha512Integrity } = await import('@main/service/backend-installer')

describe('parseAliasVersion', () => {
  test('解析 npm 别名依赖里的平台版本号', () => {
    // codex 的平台包是「同名不同版本」的别名依赖，版本号里带 - 和数字
    expect(parseAliasVersion('npm:@openai/codex@0.146.0-darwin-arm64')).toBe('0.146.0-darwin-arm64')
    expect(parseAliasVersion('npm:@openai/codex@0.146.0-win32-x64')).toBe('0.146.0-win32-x64')
  })

  test('不是别名依赖或缺失时返回 null（调用方会退回命名约定拼接）', () => {
    expect(parseAliasVersion(undefined)).toBeNull()
    expect(parseAliasVersion('^0.146.0')).toBeNull()
    expect(parseAliasVersion('npm:codex@1.0.0')).toBeNull()
  })
})

describe('parseSha512Integrity', () => {
  test('取出 sha512 的 base64 摘要', () => {
    expect(parseSha512Integrity('sha512-hTQR5jy/ObfTf1MDnuJCZJAe')).toBe('hTQR5jy/ObfTf1MDnuJCZJAe')
  })

  test('多算法字符串里只挑 sha512', () => {
    expect(parseSha512Integrity('sha1-abc sha512-def')).toBe('def')
  })

  test('没有 sha512 时返回 null——调用方据此跳过校验而不是误判为不匹配', () => {
    expect(parseSha512Integrity('sha1-abc')).toBeNull()
    expect(parseSha512Integrity('')).toBeNull()
  })
})
