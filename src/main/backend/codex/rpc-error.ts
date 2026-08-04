/**
 * codex JSON-RPC 的结构化错误。
 *
 * 单独一个类而不是裸 `new Error(msg.error.message)`：codex 把**能判断的错误码**放在
 * `error.data` 里（配置写入失败是 `data.config_write_error_code`），只留 message 的话
 * 上层就只剩一条英文散文，判断只能靠字符串匹配——那既不可靠，也在 codex 改文案时
 * 无声失效。
 */
export class CodexRpcError extends Error {
  constructor(
    message: string,
    /** JSON-RPC 的数字错误码（-32600 等），诊断用。 */
    readonly rpcCode?: number,
    /** codex 自己的结构化载荷。形状随方法不同，取值前必须 narrow。 */
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'CodexRpcError'
  }
}

/**
 * `config/value/write` / `config/batchWrite` 的失败原因（实测取值）。
 *
 * 目前只确认了 `configVersionConflict` 一个——它是传了过期 `expectedVersion` 时返回的。
 * 其余取值没有实测到，所以这里不去枚举猜测的值：判不出来就交给调用方按未知处理，
 * 比编一个可能不存在的码好。
 */
export function codexConfigWriteErrorCode(error: unknown): string | null {
  if (!(error instanceof CodexRpcError)) return null
  const data = error.data
  if (typeof data !== 'object' || data === null) return null
  const code = (data as { config_write_error_code?: unknown }).config_write_error_code
  return typeof code === 'string' ? code : null
}
