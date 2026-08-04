/**
 * codex JSON-RPC 结构化错误的提取。
 *
 * 之所以值得一个独立文件：codex 把可判别的错误码放在 `error.data` 里，而 adapter
 * 以前只把 `error.message` 包成 Error 抛出去——上层就只剩一句英文散文可判。
 * 这组用例钉住"data 要带出来，且取不到时老实返回 null 而不是猜"。
 */
import { CodexRpcError, codexConfigWriteErrorCode } from '@main/backend/codex/rpc-error'
import { describe, expect, test } from 'vitest'

describe('codexConfigWriteErrorCode', () => {
  test('从 data 里取出乐观锁冲突码', () => {
    // 实测载荷：{"code":-32600,"data":{"config_write_error_code":"configVersionConflict"},
    //           "message":"Configuration was modified since last read. …"}
    const error = new CodexRpcError('Configuration was modified since last read.', -32600, {
      config_write_error_code: 'configVersionConflict',
    })
    expect(codexConfigWriteErrorCode(error)).toBe('configVersionConflict')
  })

  test('普通 Error 返回 null——不去猜', () => {
    expect(codexConfigWriteErrorCode(new Error('boom'))).toBeNull()
  })

  test('data 不是对象 / 没有那个字段时返回 null', () => {
    expect(codexConfigWriteErrorCode(new CodexRpcError('x', -1, 'not an object'))).toBeNull()
    expect(codexConfigWriteErrorCode(new CodexRpcError('x', -1, { other: 1 }))).toBeNull()
    expect(codexConfigWriteErrorCode(new CodexRpcError('x'))).toBeNull()
  })

  test('message 仍然是可读的——翻译不了的时候还得靠它', () => {
    const error = new CodexRpcError('Configuration was modified', -32600, {})
    expect(error.message).toBe('Configuration was modified')
    expect(error.name).toBe('CodexRpcError')
  })
})
