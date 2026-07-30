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

/**
 * 模型列表的获取方式。
 *
 * `auto`：从上游 modelsUrl 拉取（现有行为）；DeepSeek/Anthropic 这类有列表接口的用这个。
 * `manual`：用用户手填的 manualModels，不请求上游；智谱编程套餐等不提供列表接口的厂商用这个。
 */
export type BridgeModelListMode = 'auto' | 'manual'

export interface BridgeUpstreamConfig {
  /** 上游说什么协议 */
  protocol: BridgeUpstreamProtocol
  /** 上游根地址，不含具体路径。如 https://api.deepseek.com/anthropic */
  baseUrl: string
  /**
   * 模型列表端点的**完整 URL**，留空表示上游没有可用的列表接口。
   *
   * 单独一个字段而不是从 baseUrl 推导，是因为二者经常不在同一路径下：
   * DeepSeek 的列表在 OpenAI 风格的 https://api.deepseek.com/models，
   * 而对话走的是 https://api.deepseek.com/anthropic（该路径下 /models 是 404）。
   */
  modelsUrl: string
  /**
   * 兜底模型名——codex 发来的模型名不在上游模型列表里时用它顶上。
   *
   * 留空则原样透传 codex 请求里的模型名。注意 codex 的 `model/list` 返回的是它
   * 编译进二进制的 ChatGPT 目录（gpt-5.6-sol 等），跟上游毫无关系，所以这个兜底
   * 在拉不到上游列表时是唯一能让请求不 400 的东西。
   */
  model: string | null
  credentialSource: BridgeCredentialSource
  /** credentialSource === 'env' 时使用的环境变量名 */
  credentialEnvVar: string
  /** 上游能力/怪癖 */
  capabilities: UpstreamCapabilities
  /** 模型列表获取方式；auto=拉取上游接口，manual=用手填列表 */
  modelListMode: BridgeModelListMode
  /** modelListMode === 'manual' 时的手填模型 id 列表 */
  manualModels: string[]
}

/**
 * 一份完整的上游配置（含元数据）。id 是稳定主键，切换只改 currentProviderId 不挪数据。
 */
export interface BridgeProvider extends BridgeUpstreamConfig {
  /** UUID v4，稳定主键 */
  id: string
  /** 用户可改名，如「我的 DeepSeek」；UI 显示用 */
  name: string
  /** 来源预设 id（deepseek/anthropic/zhipu/custom），仅 UI 回显用 */
  presetId: string
  /** 创建时间戳（毫秒），用于排序（升序） */
  createdAt: number
}

/**
 * BridgeManager 消费的整份桥配置。
 * providers 是全部已保存配置；currentProviderId 指向当前启用的一个（'' 表示未选）。
 */
export interface BridgeSettings {
  enabled: boolean
  currentProviderId: string
  providers: Record<string, BridgeProvider>
}

/**
 * 从上游模型列表接口拉到的一个模型。
 *
 * 刻意不复用 backend 层的 ModelOption——协议层不该认识 backend 的类型，
 * 由 backend 侧自己把这个最小结构映射过去。
 */
export interface BridgeModelInfo {
  id: string
  displayName: string
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
      // 实测：/anthropic 路径下没有列表接口（404），列表只在 OpenAI 风格的根路径上
      modelsUrl: 'https://api.deepseek.com/models',
      model: 'deepseek-v4-pro',
      credentialEnvVar: 'DEEPSEEK_API_KEY',
      capabilities: {
        // 官方兼容性表：Images / Documents 明确列为 Not Supported
        supportsImages: false,
        // 注：官方兼容性表还写着 Extended thinking「Supported (budget_tokens is ignored)」。
        // 这是要在 description 里告知用户的事实，不是能力开关——桥无论如何都得发
        // budget_tokens（Anthropic 协议必填），上游理不理会不由桥决定。
        dropSamplingWhenThinking: true,
        defaultMaxOutputTokens: 8192,
        toolNameMaxLength: 64,
      },
      modelListMode: 'auto',
      manualModels: [],
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
      modelsUrl: 'https://api.anthropic.com/v1/models',
      model: null,
      credentialEnvVar: 'ANTHROPIC_API_KEY',
      capabilities: { ...DEFAULT_UPSTREAM_CAPABILITIES },
      modelListMode: 'auto',
      manualModels: [],
    },
  },
  {
    id: 'zhipu',
    label: '智谱编程套餐',
    description:
      '智谱 GLM 的 Anthropic 兼容端点（编程套餐）。套餐不提供模型列表接口，模型需手填；图片/思考支持视具体模型而定。',
    docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/overview',
    config: {
      protocol: 'anthropic.messages',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      // 套餐不提供列表接口，manual 模式用手填列表
      modelsUrl: '',
      model: 'GLM-5.2',
      // 用厂商语义名，避免和 Anthropic 官方的 ANTHROPIC_API_KEY 混淆
      credentialEnvVar: 'ZHIPUAI_API_KEY',
      capabilities: {
        // 编程套餐通用模型不一定支持视觉（仅 GLM-4.6V 支持），保守关
        supportsImages: false,
        // 文档未提及 extended thinking，按保守默认
        dropSamplingWhenThinking: true,
        defaultMaxOutputTokens: 8192,
        toolNameMaxLength: 64,
      },
      modelListMode: 'manual',
      manualModels: ['GLM-5.2', 'GLM-5-Turbo', 'GLM-4.7'],
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
      modelsUrl: '',
      model: null,
      credentialEnvVar: '',
      capabilities: { ...DEFAULT_UPSTREAM_CAPABILITIES, supportsImages: false },
      modelListMode: 'auto',
      manualModels: [],
    },
  },
]

export function bridgeUpstreamPreset(id: string): BridgeUpstreamPreset | undefined {
  return BRIDGE_UPSTREAM_PRESETS.find((preset) => preset.id === id)
}

/**
 * 从预设创建一个新的 provider（带新生成的 id）。
 *
 * 用全局 crypto.randomUUID() 而非 node:crypto——shared 层禁 node:*，
 * 而全局 Web Crypto 在 renderer 和 main（Node 19+）都可用。
 */
export function createProviderFromPreset(
  presetId: string,
  credentialSource: BridgeCredentialSource = 'stored',
): BridgeProvider {
  // 'custom' 必然存在于预设表，! 断言安全
  const preset = bridgeUpstreamPreset(presetId) ?? bridgeUpstreamPreset('custom')!
  return {
    id: crypto.randomUUID(),
    name: preset.label,
    presetId: preset.id,
    createdAt: Date.now(),
    ...preset.config,
    credentialSource,
  }
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
  /**
   * 当前启用的 provider id；null 表示未选任何配置。
   *
   * 注意与 BridgeSettings.currentProviderId 的 sentinel 区别：settings 里用空串 ''
   * 表示未选（Zod string 默认值，落盘 settings.json）；这里是运行时状态，用 null
   * 表示「没有当前 provider」，和本接口其它可空字段（port/baseUrl 等）保持一致。
   * 二者由 manager.status() 在边界处转换：settings.currentProviderId 为 '' 时这里回 null。
   */
  currentProviderId: string | null
  upstreamProtocol: BridgeUpstreamProtocol | null
  upstreamBaseUrl: string | null
  /** 凭证是否已就绪（只报 true/false，绝不回传密钥本身） */
  credentialReady: boolean
  lastError: string | null
}
