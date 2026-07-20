/**
 * 后端 CLI 健康检测：跑 `<binary> --version`，区分失败原因。
 *
 * 抽出来是因为 CodexAdapter / ClaudeAdapter 都需要同样的诊断逻辑——
 * 尤其是给出能告诉用户「为什么不可用 + 怎么修」的错误码。
 */
import { spawnSync } from 'node:child_process'

export interface HealthResult {
  ok: boolean
  version?: string
  /**
   * 失败时的错误码，UI 用来显示对应的修复指引：
   * - 'not-installed'  : binary 不在 PATH 里（ENOENT）→ 装一下
   * - 'killed-by-os'   : 进程被 SIGKILL（macOS Gatekeeper / 内存不足 / 证书吊销）
   * - 'timeout'        : 超过 5s 没返回
   * - 'non-zero-exit'  : 进程异常退出（exit code != 0）
   * - 'spawn-error'    : 其他 spawn 错误（兜底）
   */
  error?: string
  /** 退出码（如果有）—— 仅用于诊断日志 */
  exitCode?: number | undefined
  /** 信号（如果有）—— 仅用于诊断日志 */
  signal?: string | undefined
}

/**
 * 跑 `<binary> --version`，根据结果返回诊断信息。
 * 默认 timeout 5 秒。
 */
export function checkCliHealth(binary: string, args: string[] = ['--version']): HealthResult {
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync(binary, args, {
      encoding: 'utf-8',
      timeout: 5000,
      shell: false, // 不走 shell，避免 shell 转义 + 更快
    })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    return {
      ok: false,
      error: code === 'ENOENT' ? 'not-installed' : 'spawn-error',
    }
  }

  // spawnSync 在 ENOENT 时不会抛——而是返回带 error 字段的对象
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code
    return {
      ok: false,
      error: code === 'ENOENT' ? 'not-installed' : 'spawn-error',
    }
  }

  // 被信号杀掉——最常见的场景就是 macOS Gatekeeper SIGKILL（cert revoked / 未签名）
  if (result.signal) {
    return {
      ok: false,
      error: result.signal === 'SIGKILL' ? 'killed-by-os' : 'spawn-error',
      signal: result.signal,
    }
  }

  // 超时（spawnSync 会用 null signal + status 表示超时）
  if (result.status === null && result.signal === null) {
    return { ok: false, error: 'timeout' }
  }

  // 非零退出码
  if (result.status !== 0) {
    const out: HealthResult = { ok: false, error: 'non-zero-exit' }
    if (result.status !== null) out.exitCode = result.status
    return out
  }

  // encoding: 'utf-8' 模式下 stdout 一定是 string，但 TS 默认类型推断没体现
  const stdout = result.stdout as string | undefined
  const version = (stdout ?? '').trim()
  // 用 conditional spread 避免 exactOptionalPropertyTypes 报错（version?: string 不接受 undefined）
  const base: { ok: boolean; version?: string } = { ok: true }
  if (version) base.version = version
  return base
}
