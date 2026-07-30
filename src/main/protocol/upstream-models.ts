/**
 * 拉取上游的模型列表。
 *
 * 为什么需要这个：codex 的 `model/list` JSON-RPC 返回的是**编译进 codex 二进制的
 * ChatGPT 目录**（gpt-5.6-sol / gpt-5.6-terra / …），它既不看 `model_provider`，
 * 也不会去请求 provider 的 /v1/models（实测：把 provider 指向本机桥后 codex 全程没有
 * 访问过桥的 /models，model/list 照样返回 gpt-*）。所以桥开着的时候，模型列表必须由
 * catmax 自己从上游拉，绕开 codex 那份写死的目录。
 */
import type { BridgeModelInfo } from '@shared/protocol/bridge-config'

import { logger } from '../service/logger'

const log = logger.domain('bridge-models')

/** 列表接口不该拖住设置页/下拉框，超时给短一点 */
const MODELS_TIMEOUT_MS = 15_000

export interface UpstreamModelsTarget {
  /** 显式配置的列表地址；留空则从 baseUrl 猜 */
  modelsUrl: string
  baseUrl: string
  apiKey: string
}

/**
 * 候选的列表地址。
 *
 * 配了就只用配的；没配就从 baseUrl 的 origin 猜两个常见位置。猜测这一步是为了让
 * 老配置（没有 modelsUrl 字段）和自定义上游不用手填也能work——DeepSeek 的对话端点在
 * /anthropic 下但列表在根路径，光靠拼接 baseUrl 是猜不中的，所以按 origin 猜。
 */
export function candidateModelsUrls(target: UpstreamModelsTarget): string[] {
  const explicit = target.modelsUrl.trim()
  if (explicit) return [explicit]

  const base = target.baseUrl.trim()
  if (!base) return []
  try {
    const origin = new URL(base).origin
    return [`${origin}/v1/models`, `${origin}/models`]
  } catch {
    return []
  }
}

/**
 * 拉一次上游模型列表。所有候选地址都失败就抛——调用方决定是回退还是提示用户。
 *
 * 认证头两种风格同时发（Bearer + x-api-key）：模型列表端点的协议风格和对话端点
 * 未必一致（DeepSeek 对话走 Anthropic 风格，列表却是 OpenAI 风格的 Bearer），
 * 两个头都带上就不用再为此加一个配置项。反正都是同一个 key 发给同一个上游主机，
 * 不存在把凭证泄露给第三方的问题。
 */
export async function fetchUpstreamModels(
  target: UpstreamModelsTarget,
  signal?: AbortSignal,
): Promise<BridgeModelInfo[]> {
  const candidates = candidateModelsUrls(target)
  if (candidates.length === 0) throw new Error('未配置模型列表地址，且无法从上游地址推断')

  const failures: string[] = []
  for (const url of candidates) {
    try {
      return await fetchOnce(url, target.apiKey, signal)
    } catch (error) {
      failures.push(`${url} → ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(failures.join('；'))
}

async function fetchOnce(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<BridgeModelInfo[]> {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${apiKey}`,
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    signal: signal ?? AbortSignal.timeout(MODELS_TIMEOUT_MS),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`${response.status} ${detail.slice(0, 200)}`)
  }

  const models = decodeModelList(await response.json())
  if (models.length === 0) throw new Error('返回了空的模型列表')
  log.info('fetched upstream models', { url, count: models.length })
  return models
}

/**
 * 容忍式解码。OpenAI 风格 `{data:[{id}]}` 和 Anthropic 风格
 * `{data:[{id, display_name}]}` 结构一致，一个解析器就够；再顺带认 `{models:[…]}`。
 */
export function decodeModelList(body: unknown): BridgeModelInfo[] {
  if (typeof body !== 'object' || body === null) return []
  const record = body as Record<string, unknown>
  const raw = record.data ?? record.models
  if (!Array.isArray(raw)) return []

  const seen = new Set<string>()
  const models: BridgeModelInfo[] = []
  for (const item of raw) {
    // 有的实现直接给字符串数组
    if (typeof item === 'string') {
      if (item && !seen.has(item)) {
        seen.add(item)
        models.push({ id: item, displayName: item })
      }
      continue
    }
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    const id = typeof entry.id === 'string' ? entry.id : null
    if (!id || seen.has(id)) continue
    seen.add(id)
    const displayName =
      typeof entry.display_name === 'string'
        ? entry.display_name
        : typeof entry.displayName === 'string'
          ? entry.displayName
          : id
    models.push({ id, displayName })
  }
  return models
}
