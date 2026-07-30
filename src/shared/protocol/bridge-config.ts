/**
 * Protocol Bridge 的用户可配置面 + 内置上游预设。
 *
 * 桥接的定位：codex 只会说 OpenAI Responses（0.96 起 `wire_api = "chat"` 已被移除，
 * 2026-02 起是硬错误），而很多上游只提供 Chat Completions / Anthropic Messages。
 * catmax 在本机起一个只听 127.0.0.1 的 HTTP 服务，对 codex 装成 Responses 端点，
 * 对上游说上游的协议。
 */
import { type UpstreamCapabilities, DEFAULT_UPSTREAM_CAPABILITIES } from './codec'
import type { ProtocolId } from './ir'

/** 目前桥接支持的上游协议。Chat Completions 的 codec 未实现，故暂不列出。 */
export const BRIDGE_UPSTREAM_PROTOCOLS = ['anthropic.messages'] as const
export type BridgeUpstreamProtocol = (typeof BRIDGE_UPSTREAM_PROTOCOLS)[number]

/**
 * 上游凭证的来源。
 *
 * `env`：只存环境变量名，值在请求时从 process.env 读——catmax 不落盘任何密钥。
 * `stored`：用户直接粘贴，catmax 存在 userData 下 0600 的单独文件里
 *           （**不进 settings.json**，那个文件会被备份/同步，且是 0644）。
 */
export type BridgeCredentialSource = 'env' | 'stored'

export interface BridgeUpstreamConfig {
  /** 上游说什么协议 */
  protocol: BridgeUpstreamProtocol
  /** 上游根地址，不含具体路径。如 https://api.deepseek.com/anthropic */
  baseUrl: string
  /** 发给上游的模型名。留空则透传 codex 请求里的模型名 */
  model: string | null
  credentialSource: BridgeCredentialSource
  /** credentialSource === 'env' 时使用的环境变量名 */
  credentialEnvVar: string
  /** 上游能力/怪癖 */
  capabilities: UpstreamCapabilities
}

export interface BridgeSettings {
  enabled: boolean
  upstream: BridgeUpstreamConfig
}

/** 内置上游预设——填好各家的 base_url 和已知怪癖，用户只要贴 key */
export interface BridgeUpstreamPreset {
  id: string
  label: string
  description: string
  docsUrl: string
  config: Omit<BridgeUpstreamConfig, 'credentialSource' | 'credentialEnvVar'> & {
    credentialEnvVar: string
  }
}

export const BRIDGE_UPSTREAM_PRESETS: readonly BridgeUpstreamPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description:
      'DeepSeek 的 Anthropic 兼容端点。支持思考与工具调用；不支持图片，thinking budget 被忽略（思考强度档位实际不生效）。',
    docsUrl: 'https://api-docs.deepseek.com/guides/anthropic_api/',
    config: {
      protocol: 'anthropic.messages',
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-v4-pro',
      credentialEnvVar: 'DEEPSEEK_API_KEY',
      capabilities: {
        // 官方兼容性表：Images / Documents 明确列为 Not Supported
        supportsImages: false,
        // 官方兼容性表：Extended thinking「Supported (budget_tokens is ignored)」
        respectsThinkingBudget: false,
        dropSamplingWhenThinking: true,
        defaultMaxOutputTokens: 8192,
        toolNameMaxLength: 64,
      },
    },
  },
  {
    id: 'anthropic',
    label: 'Anthropic 官方',
    description: 'Anthropic 官方 Messages API。图片、思考签名、budget 全部原生支持。',
    docsUrl: 'https://docs.anthropic.com/en/api/messages',
    config: {
      protocol: 'anthropic.messages',
      baseUrl: 'https://api.anthropic.com',
      model: null,
      credentialEnvVar: 'ANTHROPIC_API_KEY',
      capabilities: { ...DEFAULT_UPSTREAM_CAPABILITIES },
    },
  },
  {
    id: 'custom',
    label: '自定义',
    description: '任何 Anthropic Messages 兼容端点。能力按最保守的一档默认。',
    docsUrl: 'https://docs.anthropic.com/en/api/messages',
    config: {
      protocol: 'anthropic.messages',
      baseUrl: '',
      model: null,
      credentialEnvVar: '',
      capabilities: { ...DEFAULT_UPSTREAM_CAPABILITIES, supportsImages: false },
    },
  },
]

export function bridgeUpstreamPreset(id: string): BridgeUpstreamPreset | undefined {
  return BRIDGE_UPSTREAM_PRESETS.find((preset) => preset.id === id)
}

export const DEFAULT_BRIDGE_UPSTREAM: BridgeUpstreamConfig = {
  protocol: 'anthropic.messages',
  baseUrl: '',
  model: null,
  credentialSource: 'stored',
  credentialEnvVar: '',
  capabilities: { ...DEFAULT_UPSTREAM_CAPABILITIES },
}

/** codex 侧使用的固定标识——写进 config.toml 的 provider 名 */
export const BRIDGE_CODEX_PROVIDER_ID = 'catmax-bridge'
/** 传给 codex 的环境变量名（值是桥的一次性 token，不是上游真 key） */
export const BRIDGE_TOKEN_ENV_VAR = 'CATMAX_BRIDGE_TOKEN'

/** 客户端侧协议固定是 Responses——codex 只会说这个 */
export const BRIDGE_CLIENT_PROTOCOL: ProtocolId = 'openai.responses'

/** 桥的运行时状态，给设置页显示 */
export interface BridgeStatus {
  running: boolean
  port: number | null
  /** 写进 codex config.toml 的 base_url */
  baseUrl: string | null
  upstreamProtocol: BridgeUpstreamProtocol | null
  upstreamBaseUrl: string | null
  /** 凭证是否已就绪（只报 true/false，绝不回传密钥本身） */
  credentialReady: boolean
  lastError: string | null
}
