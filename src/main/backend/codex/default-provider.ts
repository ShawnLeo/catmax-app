/**
 * 读 codex 自己 config.toml 里生效的 `model_provider`。
 *
 * 为什么需要它：codex 把 provider **写死在每个会话的 rollout 里**，`thread/resume` 会
 * 连同历史一起恢复它。catmax 开桥时把 provider 覆盖成 `catmax-bridge`，于是那段时间
 * 建的会话在 rollout 里也记成了 `catmax-bridge`——关桥后再打开，codex 直接
 * `failed to load configuration: Model provider \`catmax-bridge\` not found`，
 * 会话既读不出历史也发不出消息（实测 thread/resume 报错、后续 turn/start 报 thread not found）。
 *
 * 所以关桥时 resume 必须显式把 provider 还原成"codex 没有 catmax 时本来会用的那个"。
 * 不能硬编码 'openai'：用户很可能自定义过（比如为了关掉 WebSocket 而写了
 * `model_provider = "openai-custom"`），硬编码会把他们的配置顶掉。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveBackendConfigDir } from '@main/service/backend-config-files'
import { logger } from '@main/service/logger'
import { parse as parseToml } from 'smol-toml'

const log = logger.domain('codex-config')

/** codex 内置默认——config.toml 不存在或没写 model_provider 时就是它 */
export const CODEX_BUILTIN_PROVIDER_ID = 'openai'

/**
 * 解析当前生效的 provider id。
 *
 * profile 优先：config.toml 里写了 `profile = "x"` 时，`[profiles.x].model_provider`
 * 覆盖顶层同名键（catmax 不传 `--profile`，所以只需看配置里声明的那个）。
 * 任何一步失败都退回内置默认——这个函数只是为了"别把用户的配置弄丢"，
 * 不该因为一个语法错误的 config.toml 就让会话打不开。
 */
export async function readCodexDefaultProvider(): Promise<string> {
  const path = join(resolveBackendConfigDir('codex'), 'config.toml')
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    return CODEX_BUILTIN_PROVIDER_ID // 文件不存在 = 全默认
  }
  try {
    const parsed = parseToml(raw) as Record<string, unknown>
    const profileName = typeof parsed.profile === 'string' ? parsed.profile : null
    if (profileName) {
      const profiles = parsed.profiles
      const profile =
        profiles && typeof profiles === 'object'
          ? (profiles as Record<string, unknown>)[profileName]
          : null
      const fromProfile =
        profile && typeof profile === 'object'
          ? (profile as Record<string, unknown>).model_provider
          : null
      if (typeof fromProfile === 'string' && fromProfile.trim()) return fromProfile.trim()
    }
    const top = parsed.model_provider
    if (typeof top === 'string' && top.trim()) return top.trim()
  } catch (e) {
    log.warn('config.toml 解析失败，按内置默认 provider 处理:', e)
  }
  return CODEX_BUILTIN_PROVIDER_ID
}
