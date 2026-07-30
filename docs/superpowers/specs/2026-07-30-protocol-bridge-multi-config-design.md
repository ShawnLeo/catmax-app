# 协议转换桥多上游配置设计

> 状态：已设计，待评审
> 日期：2026-07-30
> 背景：协议桥当前只能存一个上游配置，切换预设会覆盖式丢失。参考 cc-switch 的「多配置 + 单一启用」模式，支持保存多个上游配置、热切换启用其中一个。

## 背景与目标

### 现状

协议转换桥（`protocolBridge`）让 codex 能接非 Responses 协议的上游（如 Anthropic Messages / DeepSeek）。当前数据模型是**单配置**：

- `settings.protocolBridge: { enabled, presetId, upstream: {...} }`，存一份上游配置。
- UI 用一个预设下拉（deepseek / anthropic / custom），`applyPreset` **覆盖式**写入唯一的 `upstream`——切预设即丢旧配置。
- 凭证存在 `userData/bridge-credentials.json`（0600）的**固定 key** `codex-bridge` 下，单槽位。
- 模型列表**只能自动拉取**——部分厂商（如智谱编程套餐）不提供模型列表接口，桥拉不到就只剩兜底模型名。

### 目标

1. 像 cc-switch 那样：保存多个上游配置（provider），同时只能有一个被启用（current）。切换到另一个配置时**热切换**生效，不丢数据、不重启桥服务。
2. 支持**手动录入模型列表**：对不提供模型列表接口的厂商，用户手填一份模型清单，桥据此填充 codex 下拉框、并把它作为 `knownModelIds` 供 `resolveModel` 判断（认识就透传、不认识用兜底名）。
3. 新增**智谱编程套餐**预设模板（base_url `https://open.bigmodel.cn/api/anthropic`，默认手动模型列表模式）。

### 关键约束

1. **桥仅对 codex 后端有效**。claude 走 `@anthropic-ai/claude-agent-sdk` 直连，不经过桥。本次改造**不改动这条 codex-only 边界**——`protocolBridge` 仍留在 `appSettingsSchema` 顶层，UI 的 `v-if="defaultBackend === 'codex'"` 门保留不动，claude 插件一行不碰。
2. **密钥永不进 settings.json**（它是 0644、会被备份同步、renderer 能整份读走）。provider 的元数据进 settings.json，密钥仍单独存 0600 文件。
3. **不做旧数据迁移**（用户决定：新装即新格式）。旧 settings.json 残留的 `upstream` 字段靠 Zod 非 strict schema 静默剥除，不报错。
4. **YAGNI**：配置通常就两三个，拖拽排序、独立 IPC（addProvider/deleteProvider）均不做。

---

## 第 1 部分：数据模型（Schema + 类型）

### 1.1 决策：方案 A —— `providers: Record<id, Provider>` + `currentProviderId`

复用 cc-switch 的结构。`id`（UUID v4）是稳定主键，切换只改 `currentProviderId` 不挪数据；凭证存储的 `Record<string,string>` 直接用 provider id 当 key，零额外设计。

考虑过另外两种：
- **方案 B（`providers: Provider[]` 数组）**：有序性免费但增删改要遍历找 index，且和 cc-switch 源码不一致。否决。
- **方案 C（每 provider 一个数据文件）**：过度设计，引入目录扫描/文件监听/多份原子写。YAGNI，否决。

### 1.2 新 Zod schema（`src/shared/settings-schema.ts`）

```ts
const bridgeProviderSchema = z.object({
  id: z.string(),                                    // UUID v4，稳定主键
  name: z.string().default(''),                      // 用户可改名，如「我的 DeepSeek」
  /** 来源预设 id（deepseek/anthropic/zhipu/custom），仅 UI 回显用 */
  presetId: z.string().default('custom'),
  createdAt: z.number().int().default(0),            // 排序用（升序），0 表示未知
  // —— 以下是原 BridgeUpstreamConfig 的全部字段，原样搬过来 ——
  protocol: z.enum(['anthropic.messages']).default('anthropic.messages'),
  baseUrl: z.string().default(''),
  modelsUrl: z.string().default(''),
  model: z.string().nullable().default(null),
  credentialSource: z.enum(['env', 'stored']).default('stored'),
  credentialEnvVar: z.string().default(''),
  capabilities: upstreamCapabilitiesSchema.default({}),
  // —— 新增：模型列表来源 ——
  /**
   * 模型列表的获取方式。
   * auto：从上游 modelsUrl 拉取（现有行为）；
   * manual：用用户手填的 manualModels，不请求上游。
   * 部分厂商（智谱编程套餐等）不提供列表接口，只能 manual。
   */
  modelListMode: z.enum(['auto', 'manual']).default('auto'),
  /** modelListMode === 'manual' 时生效；手动录入的模型 id 列表 */
  manualModels: z.array(z.string()).default([]),
})

const protocolBridgeSchema = z.object({
  enabled: z.boolean().default(false),
  /** 当前启用的 provider id；为空字符串表示未选任何配置 */
  currentProviderId: z.string().default(''),
  providers: z.record(z.string(), bridgeProviderSchema).default({}),
})
```

关键点：
- 外层 `enabled` + `currentProviderId` 保留在 schema 里（进 settings.json，受 0644 文件管控，没问题）。
- provider 的 `id` 是稳定主键，切换只改 `currentProviderId`，不挪数据。
- `presetId` **下沉**到每个 provider（记录「这个配置是从哪个预设来的」），外层不再有 `presetId`。
- 旧的 `upstream` 字段**直接删掉**（按不迁移决定）。旧 settings.json 里若有残留 `upstream`，因 schema 是非 `.strict()` 的普通 `z.object`，未知键被静默剥掉，不会报错——这正是现有注释里写的删字段兼容保障。

### 1.3 类型层（`src/shared/protocol/bridge-config.ts`）

**先扩 `BridgeUpstreamConfig`**（新增模型列表来源两个字段）：

```ts
export type BridgeModelListMode = 'auto' | 'manual'

export interface BridgeUpstreamConfig {
  protocol: BridgeUpstreamProtocol
  baseUrl: string
  modelsUrl: string
  model: string | null
  credentialSource: BridgeCredentialSource
  credentialEnvVar: string
  capabilities: UpstreamCapabilities
  // —— 新增 ——
  /** 模型列表获取方式；auto=拉取上游接口，manual=用手填列表 */
  modelListMode: BridgeModelListMode
  /** modelListMode === 'manual' 时的手填模型 id 列表 */
  manualModels: string[]
}
```

> **向后兼容注意**：这两个新字段加在 `BridgeUpstreamConfig` 上会影响 `BridgeUpstreamPreset.config` 的形状（它 `Omit<..., 'credentialSource' | 'credentialEnvVar'>`，但没 Omit 新字段）。所以 `BRIDGE_UPSTREAM_PRESETS` 里每个预设的 `config` **都要补上 `modelListMode` 和 `manualModels`**——否则 TS 报错。已有的 deepseek/anthropic/custom 三个预设补 `modelListMode: 'auto'`、`manualModels: []`（见 1.5 完整 config 示例）。

再新增 `BridgeProvider` 接口，等于 id/name/presetId/createdAt + 原 `BridgeUpstreamConfig`：

```ts
export interface BridgeProvider extends BridgeUpstreamConfig {
  id: string
  name: string
  presetId: string
  createdAt: number
}
```

`BridgeSettings`（后端消费的形状）从 `{ enabled, upstream }` 改为：

```ts
export interface BridgeSettings {
  enabled: boolean
  currentProviderId: string
  providers: Record<string, BridgeProvider>
}
```

`BRIDGE_UPSTREAM_PRESETS` **保留并新增智谱预设**（见 1.5）——它现在是「新建配置时的模板」。新增工厂函数：

```ts
/** 从预设创建一个新的 provider（带新生成的 id） */
export function createProviderFromPreset(
  presetId: string,
  credentialSource: BridgeCredentialSource = 'stored',
): BridgeProvider {
  const preset = bridgeUpstreamPreset(presetId) ?? bridgeUpstreamPreset('custom')!
  return {
    id: crypto.randomUUID(),
    name: preset.label,          // 默认名用预设名，用户可改
    presetId: preset.id,
    createdAt: Date.now(),
    ...preset.config,            // 含 protocol/baseUrl/modelsUrl/model/credentialEnvVar/capabilities/modelListMode/manualModels
    credentialSource,            // 补上 preset.config 里被 Omit 掉的唯一字段
  }
}
```

类型自洽：`preset.config` 是 `Omit<BridgeUpstreamConfig, 'credentialSource' | 'credentialEnvVar'> & { credentialEnvVar: string }`，展开后已有 `credentialEnvVar`，再补 `credentialSource`，加上前面四个元数据字段（id/name/presetId/createdAt），对象恰好满足 `BridgeProvider`。**不需要**再单独写 `credentialEnvVar:`——它已在 `...preset.config` 里，重复写是无害但多余的。

> **关键实现细节**：`createProviderFromPreset` 在 shared 层生成 UUID，**不能** `import { randomUUID } from 'node:crypto'`（shared 禁 `node:*`）。必须用**全局 `crypto.randomUUID()`**——Web Crypto API 在 renderer 和 main（Node 19+ 全局）都可用，跨层安全。

### 1.4 BridgeStatus（给 UI 显示的运行时状态）

`BridgeStatus` 增加一个 `currentProviderId` 字段，方便 UI 高亮当前激活项：

```ts
export interface BridgeStatus {
  running: boolean
  port: number | null
  baseUrl: string | null
  currentProviderId: string | null   // 新增
  upstreamProtocol: BridgeUpstreamProtocol | null
  upstreamBaseUrl: string | null
  credentialReady: boolean
  lastError: string | null
}
```

### 1.5 智谱编程套餐预设（`BRIDGE_UPSTREAM_PRESETS` 新增）

查证结论（来源：智谱官方文档 docs.bigmodel.cn + 社区配置实例）：

| 项 | 取值 | 依据 |
|---|---|---|
| base_url | `https://open.bigmodel.cn/api/anthropic` | 用户给定 + 官方 Claude Code 接入指南 |
| 协议 | `anthropic.messages` | 官方 Anthropic 兼容端点 |
| **模型列表模式** | **`manual`** | 套餐**不提供模型列表接口**，只能手填 |
| 手填模型 | `['glm-5.2', 'glm-5-turbo', 'glm-4.7']` | 官方 overview 列出；用户可增删 |
| 兜底模型 | `'glm-5.2'` | 列表里第一个、能力最新的 |
| modelsUrl | `''`（留空） | 无列表接口，manual 模式下不用 |
| 凭证环境变量名 | `ZHIPUAI_API_KEY` | 语义化命名；官方 Claude Code 直连用 `ANTHROPIC_AUTH_TOKEN`，但桥里用更明确的厂商名，避免和 Anthropic 官方 `ANTHROPIC_API_KEY` 混淆 |
| supportsImages | `false` | 编程套餐的通用模型不一定支持视觉（仅 GLM-4.6V 支持）；保守默认关，用户视情况开 |
| dropSamplingWhenThinking | `true` | 文档未提及 extended thinking，按保守默认 |
| defaultMaxOutputTokens | `8192` | 文档未明确，沿用默认 |

```ts
{
  id: 'zhipu',
  label: '智谱编程套餐',
  description:
    '智谱 GLM 的 Anthropic 兼容端点（编程套餐）。套餐不提供模型列表接口，模型需手填；图片/思考支持视具体模型而定。',
  docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/overview',
  config: {
    protocol: 'anthropic.messages',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    modelsUrl: '',                              // 无列表接口
    model: 'glm-5.2',                           // 兜底
    credentialEnvVar: 'ZHIPUAI_API_KEY',
    capabilities: {
      supportsImages: false,
      dropSamplingWhenThinking: true,
      defaultMaxOutputTokens: 8192,
      toolNameMaxLength: 64,
    },
    modelListMode: 'manual',                    // 关键：不拉取，用手填列表
    manualModels: ['glm-5.2', 'glm-5-turbo', 'glm-4.7'],
  },
},
```

### 1.6 现有三个预设补字段

deepseek / anthropic / custom 的 `config` 各补两行（它们都支持自动拉取，所以是 auto 模式）：

```ts
modelListMode: 'auto',
manualModels: [],
```

> 注意：`custom` 预设虽然 baseUrl 留空，但仍是 `auto` 模式——用户填了 baseUrl + modelsUrl 后桥会去拉。`manual` 模式是 provider 级别的选择，预设只给默认值，用户可在编辑区切换。

---


## 第 2 部分：凭证存储改造

### 2.1 核心洞察：存储层零改动

`bridge-credentials.ts` 的四个导出函数**已经全部按 `id: string` 参数化**了：

```ts
setStoredCredential(id: string, secret: string)
getStoredCredential(id: string)
hasStoredCredential(id: string)
clearStoredCredential(id: string)
```

且文件形状 `{ secrets: Record<string, string> }` 天然支持多 key。**这个文件一行都不用改。**

唯一要消除的是 `manager.ts:34` 的硬编码常量：

```ts
export const BRIDGE_CREDENTIAL_ID = 'codex-bridge'  // ← 单槽位的根源，删除
```

### 2.2 凭证 id 的选型

每个 provider 的凭证存到什么 key 下？直接用 **provider id（UUID）**：

```ts
// manager.ts 改成按当前 provider 解析
private resolveCredential(): string | null {
  const provider = this.currentProvider()
  if (!provider) return null
  if (provider.credentialSource === 'env') {
    const name = provider.credentialEnvVar.trim()
    if (!name) return null
    const value = process.env[name]?.trim()
    return value ? value : null
  }
  return getStoredCredential(provider.id)   // ← 用 provider.id，不再用常量
}
```

为什么用 provider id 而不是别的：
- id 是稳定主键，改名不影响凭证；删配置时可精准清掉对应 key。
- 不用 baseUrl 做 key：两个 provider 可能指向同地址但不同 key（测试/正式），用地址会撞。
- 不用 name 做 key：用户会改名，改名就得迁移 key，徒增复杂度。

### 2.3 IPC 改造：`setBridgeCredential` 加 providerId 参数

```ts
// src/shared/ipc/backend.ts 契约
bridge: {
  setBridgeCredential: invoke.contract<{
    providerId: string        // 新增
    secret: string
  }, BridgeStatus>()
  testBridgeUpstream: invoke.contract<{
    providerId: string        // 新增
  }, { ok: boolean; message: string }>()
}
```

`handlers.ts` 实现相应改：

```ts
export const setBridgeCredential = async (args: {
  providerId: string
  secret: string
}): Promise<BridgeStatus> => {
  setStoredCredential(args.providerId, args.secret.trim())
  bridgeManager.invalidateModels()
  // 后续重连逻辑不变（仍是 current is codex 才重连）
}
```

新增一个轻量 IPC 用于编辑非当前 provider 时显示凭证就绪状态（布尔不回传，不是密钥）：

```ts
bridge: {
  bridgeCredentialReady: invoke.contract<{ providerId: string }, boolean>()
}
```

### 2.4 关键副作用：删除 provider 时必须清凭证

`deleteProvider(id)` 必须连带 `clearStoredCredential(id)`，否则：
- 0600 文件里残留孤儿 key（卫生问题，但脏）；
- 用户删了又用同 id 重建（UUID 概率极低）会误用旧 key。

这是**删除路径专属**的逻辑，由 UI 层在 patch 前 `clearStoredCredential(id)` 负责：

```ts
// UI 层伪代码
async function deleteProvider(id: string) {
  await window.api.backend.setBridgeCredential({ providerId: id, secret: '' })  // 先清 key
  patchBridge({ providers: omit(providers, id), /* currentProviderId 顺带修正 */ })
}
```

`getStoredCredential(id)` 在 provider 不存在时返回 null，不会报错——所以「凭证残留」只是卫生问题不是正确性问题，但清掉是正确做法。

### 2.5 向后兼容（现有 stored key 的去向）

现在 `bridge-credentials.json` 里若有 `secrets['codex-bridge']`（老用户存的），改造后**没人再读这个 key**——新代码按 provider id 查。按不迁移决定，这个孤儿 key 会留在文件里，无害。不主动删（那属于迁移逻辑）。

---

## 第 3 部分：BridgeManager 运行时改造

### 3.1 内部状态：`settings` 存整份 + `currentProvider()` 取当前

manager 现在存的是 `this.settings: BridgeSettings | null`（含单个 `upstream`）。改造后存新的 `BridgeSettings`（含 `providers` + `currentProviderId`），并加一个取当前的辅助方法：

```ts
export class BridgeManager {
  private settings: BridgeSettings | null = null   // 新形状：{ enabled, currentProviderId, providers }

  /** 当前激活的 provider；未选/不存在时返回 null */
  private currentProvider(): BridgeProvider | null {
    const s = this.settings
    if (!s) return null
    const id = s.currentProviderId
    if (!id) return null
    return s.providers[id] ?? null
  }
}
```

> 为什么留 `currentProvider()` 而不在 `applySettings` 时算好缓存？因为 `resolveUpstream()` / `resolveCredential()` 每次**请求都重读**（现有设计的有意为之，见 manager.ts 注释）——这样改了 settings 立即生效、不用重启桥。缓存反而违背这个设计。

### 3.2 `applySettings`：起停 + 模型缓存失效逻辑

现在 `applySettings` 比较的是 `previous = this.settings?.upstream`。改造后比较「上一个当前 provider」和「新当前 provider」：

```ts
async applySettings(settings: BridgeSettings): Promise<void> {
  const wasEnabled = this.settings?.enabled ?? false
  const prevCurrent = this.currentProvider()      // 切换前的当前 provider 快照
  this.settings = settings
  const newCurrent = this.currentProvider()

  // 当前 provider 的「身份」变了（地址/列表/凭证来源）就丢模型缓存
  if (prevCurrent && newCurrent && upstreamModelIdentityChanged(prevCurrent, newCurrent)) {
    this.invalidateModels()
  } else if (!prevCurrent && newCurrent) {
    // 从「无当前 provider」到「有」——缓存也该丢
    this.invalidateModels()
  }

  // 起/停逻辑不变：只看 enabled
  if (settings.enabled && !wasEnabled) { /* server.start() */ }
  else if (!settings.enabled && wasEnabled) { /* server.stop() */ }
}
```

`upstreamModelIdentityChanged` 比较函数**签名不变**——它接收两个 `BridgeUpstreamConfig`，`BridgeProvider extends BridgeUpstreamConfig`，可以直接传进去（结构子类型化）。但**函数体要扩**：现在多了 `modelListMode`/`manualModels`——手动列表的内容变了也该失效缓存。所以比较逻辑要**加上 `modelListMode` 和 `manualModels` 的比较**（后者按内容而非引用比，用 join 或逐项比）。原有的 baseUrl/modelsUrl/credentialSource/credentialEnvVar 比较保留。

### 3.3 `resolveUpstream` / `resolveCredential` / `status`：全走 `currentProvider()`

三个方法统一改成从 `currentProvider()` 取值，不再读 `settings.upstream`：

- `resolveUpstream()`：`const upstream = this.currentProvider()`，其余不变（baseUrl 空检查、capabilities 等照旧）。
- `resolveCredential()`：第 2.2 节已给，按 `provider.id` 查凭证。
- `status()`：新增 `currentProviderId` 字段回传；`upstreamProtocol` / `upstreamBaseUrl` 从 `currentProvider()` 取。

`codexSpawnArgs()` / `codexSpawnEnv()` **完全不用改**——它们只看 `this.settings?.enabled` 和 `this.server`，不碰 upstream。

### 3.3a `listUpstreamModels`：auto / manual 分叉（核心新增）

这是手动模型列表的主战场。现在 `listUpstreamModels` 只会走网络拉取。改造后按当前 provider 的 `modelListMode` 分叉：

```ts
async listUpstreamModels(): Promise<BridgeModelInfo[]> {
  if (this.modelsPromise) return this.modelsPromise   // 缓存命中（auto 模式才有意义）

  const provider = this.currentProvider()
  if (!provider) return []

  // —— manual 模式：直接用手填列表，不联网 ——
  if (provider.modelListMode === 'manual') {
    const models = provider.manualModels
      .filter((id) => id.trim())
      .map((id) => ({ id: id.trim(), displayName: id.trim() }))
    // 手动列表也要喂给 knownModelIds——resolveModel 要据此判断透传还是兜底
    this.knownModelIds = new Set(models.map((m) => m.id))
    return models
  }

  // —— auto 模式：现有网络拉取逻辑（走 modelsUrl / baseUrl 推断）——
  if (!provider.baseUrl.trim()) return []
  const apiKey = this.resolveCredential()
  if (!apiKey) return []
  this.modelsPromise = (async () => { /* 现有 fetchUpstreamModels 逻辑 */ })()
  return this.modelsPromise
}
```

关键点：
1. **manual 不进 `modelsPromise` 缓存**——手填列表是同步的、随时可变（用户改了 manualModels 立即生效），缓存它反而会让「改了手填列表但没刷新」显示旧值。每次调用都重新读 `provider.manualModels`。
2. **manual 也设 `knownModelIds`**——这是关键。`resolveModel`（bridge.ts:61）的逻辑是「认识就透传、不认识用兜底名」。如果 manual 模式不设 `knownModelIds`，codex 选了用户手填的 `glm-5.2` 会被当成不认识、用兜底名顶掉（虽然兜底名也是 glm-5.2，但那是巧合）。设上之后，手填列表里的模型名一律透传，行为正确。
3. **auto 模式的 `knownModelIds` 不变**——仍在 `fetchUpstreamModels` 成功后设（manager.ts 现有逻辑）。
4. `invalidateModels()` 清缓存时，manual 模式下次调用会重读 `provider.manualModels`，所以切到 manual provider 也能正确刷新。

### 3.4 增删改 provider 的生效路径：走 settings.update，不经独立 IPC

关键设计决策。增删改 provider 不是单独的 IPC 方法，而是**复用现有的 `settings.update({ protocolBridge: {...} })`**：

```
UI 改 provider 列表 → patch 整个 protocolBridge 对象 →
  settings.update handler → applyBridgeThenBackend → bridgeManager.applySettings
```

为什么不开 `bridge.addProvider` / `deleteProvider` / `switchProvider` 这类 IPC（像 cc-switch 那样）：

| 维度 | 复用 settings.update（采用） | 独立 bridge.* IPC |
|---|---|---|
| 代码量 | 几乎为零——已有 patch 路径 | 要加 4-5 个 contract + handler + 注册 + preload 暴露 |
| 数据一致性 | provider 数据和 enabled 同源，原子更新 | 桥状态和 provider 列表分两个更新源，易竞态 |
| 热切换 | `applySettings` 里 `prevCurrent` vs `newCurrent` diff 自动处理 | 每个 IPC 各自处理，逻辑重复 |
| 凭证清理 | 删 provider 在 UI 层 patch 前 `clearStoredCredential(id)`，干净 | 同 |

provider 配置本身就是 settings 的一部分（进 settings.json），它就该走 settings 这条数据主路。凭证是唯一不进 settings.json 的部分，所以凭证读写（`setBridgeCredential`）才需要独立 IPC，而 provider 元数据不需要。

`deleteProvider` 是混合操作：先走凭证 IPC 清掉该 provider 的 key（`setBridgeCredential({ providerId, secret: '' })`），再走 settings.update 把它从 `providers` 字典里删掉并修正 `currentProviderId`。删的顺序是「先清 key、再删数据」——key 依附于 provider，数据没了就没法定位 key，所以必须先清。

### 3.5 热切换时 codex 要不要重连？

和「开关桥」必须区分：

- **开关桥（`enabled` 翻转）**：改了 `codexSpawnArgs` 的返回（空 ↔ 有 `-c`），已 spawn 的 codex 读不到新参数 → **必须重连 codex**（现有逻辑，settings handler）。
- **切换 provider（`currentProviderId` 变，enabled 不变）**：`codexSpawnArgs` 返回不变（端口/token 没变），codex 还指向同一个本机桥。上游换谁由**桥的 `resolveUpstream()` 在请求时决定**——codex 完全无感 → **不需要重连 codex**。

在 `updateSettings` 里，重连条件精确化为：

```ts
const prev = ctx.settingsStore.load().protocolBridge
const wasEnabled = prev.enabled
const updated = ctx.settingsStore.update(args.patch)
const nowEnabled = updated.protocolBridge.enabled

// 只有「桥开关翻转」才需要重连 codex；纯切换 provider 不需要（桥热切换已生效）
if (nowEnabled !== wasEnabled && ctx.backendManager.getCurrentId() === 'codex') {
  void ctx.backendManager.reconnectBackend('codex')
}
```

切换 provider 后要不要刷新模型列表？要——但不用重连 codex。`applySettings` 里的 `invalidateModels` 已经清了缓存，UI 侧切换后调一次 `backend.refreshModelsFor('codex')` 即可，桥会去新上游拉列表。

### 3.6 边界：currentProviderId 指向不存在的 provider

用户可能删掉当前激活的 provider。处理：删 provider 时 UI **必须**同步修正 `currentProviderId`：
- 若还有别的 provider，指向第一个（按 createdAt）；
- 若 providers 空了，置 `''`。

后端侧 `currentProvider()` 返回 null 时，`resolveUpstream()` 返回 null → 桥回 503 给人话提示（「未选择上游配置」），和现在「配置不完整」的 503 一致。**后端不做「自动选一个」的容错**——数据修正归 UI（单一数据源），后端只如实反映状态。

---

## 第 4 部分：UI 改造（`ProtocolBridgeSection.vue`）

### 4.1 现状回顾

现在这个组件用一组**平铺表单**编辑单个 `upstream`：
- 顶部 `enabled` toggle + 运行状态条
- 「上游」下拉（`presetId` → `applyPreset` 整套灌入，覆盖式）
- baseUrl / 兜底模型名 / modelsUrl / 凭证 / 测试 / 能力，全绑在单个 `upstream` 上
- `secretDraft` 是组件局部 ref（不回显密钥）

改造核心：把单个平铺表单变成「provider 列表 + 选中当前编辑」两层。

### 4.2 新 UI 结构

```
┌─ 协议转换桥  [已开启/已关闭  ◯─toggle]
│   (说明文案不变)
│
├─ [运行状态条]  (enabled 时显示)
│
├─ 上游配置列表                          ← 新增的「列表层」
│   ┌─────────────────────────────────┐
│   │ ◉ 我的 DeepSeek      [当前] ✎ 🗑 │  ← 选中态(当前激活)+编辑+删除
│   │ ○ Anthropic 官方        ✎ 🗑    │  ← 未激活:点 radio 切换为当前
│   │ ○ 智谱编程套餐         ✎ 🗑      │
│   └─────────────────────────────────┘
│   [+ 新建配置 ▾]  ← 下拉:DeepSeek / Anthropic / 智谱 / 自定义(四个预设模板)
│
└─ [选中 provider 的编辑区]              ← 原「平铺表单」整体下移到这里
    名称 / baseUrl / 兜底模型名
    模型列表来源 [auto ▾] ──┬─ auto:  modelsUrl 输入 + [拉取上游模型列表] 按钮
                            └─ manual: 手填模型清单(每行一个 / tag 输入)
    凭证(按 providerId 存) / 测试连通 / 能力
```

### 4.3 「选中编辑」与「当前激活」的区分（关键设计）

容易混淆的点，必须明确拆成**两个独立的 ref**：

- **`currentProviderId`**（来自 settings）：桥实际在用的上游。**只有点 radio 或删除时才改**。
- **`editingProviderId`**（组件局部 ref）：当前在下方编辑区显示哪一项。**点 ✎ 或新建时改**，和 current 互不绑定。

为什么不合并？因为常见操作是「编辑一个非当前 provider 的字段（比如改 DeepSeek 的 baseUrl），但不立即切换到它」。如果编辑=切换，用户每改一个字符都触发一次热切换+刷模型，体验灾难。所以：

- **编辑** = 改 `editingProviderId` + 改 providers 数据（走 patchBridge），**不动 currentProviderId**。
- **切换** = 改 `currentProviderId`（走 patchBridge），不动数据。

只有 radio 那一下才切 current。编辑区改字段只更新该 provider 在 `providers[id]` 里的值。

### 4.4 列表可见性

**provider 列表和编辑区始终可见**，不随 `enabled` 隐藏。只有「运行状态条」随 enabled 显示。

理由（用户决定）：符合「先把多个配置准备好再开桥」的心智——关桥时也能增删改 provider、填 key。开桥后立即指向关桥前的 `currentProviderId`。

### 4.5 交互要点

| 操作 | 行为 |
|---|---|
| 点列表项的 **radio（◉/○）** | 切换 `currentProviderId` 为该项 → 热切换，刷模型 |
| 点 **✎ 编辑** | 该项进入「编辑选中」状态，下方编辑区显示它的字段 |
| 点 **🗑 删除** | 先 `setBridgeCredential({providerId, secret:''})` 清 key → 从 providers 删 → 修正 currentProviderId → patch |
| **[+ 新建 ▾]** | 下拉选预设 → `createProviderFromPreset` 生成新项（带新 UUID）→ 加入 providers → 自动设为 current + 进入编辑 |

### 4.6 函数改造对照表

| 现有函数 | 改造后 |
|---|---|
| `patchBridge` | 不变（仍 patch 整个 protocolBridge） |
| `patchUpstream` | → `patchProvider(providerId, patch)`：改 `providers[providerId]` 里的字段，不动 currentProviderId |
| `patchCapabilities` | 同上，落到 `providers[providerId].capabilities` |
| `applyPreset` | **删除**（不再有外层 presetId）。预设只在「新建配置」时用 |
| `toggleEnabled` | 不变（开关翻转仍要刷模型） |
| `refreshModels` | 不变 |
| `saveSecret` | `setBridgeCredential({ providerId: editingId, secret })` |
| `clearSecret` | `setBridgeCredential({ providerId: editingId, secret: '' })` |
| `testUpstream` | `testBridgeUpstream({ providerId: editingId })` |
| **新增** `switchProvider(id)` | `patchBridge({ currentProviderId: id })` + `refreshModels()` |
| **新增** `addProvider(presetId)` | `createProviderFromPreset` → 加入 providers → 设为 current+editing |
| **新增** `deleteProvider(id)` | 清 key → 从 providers 删 → 修正 current → patch |
| **新增** `selectEditing(id)` | `editingProviderId = id` |
| **新增** `setModelListMode(mode)` | `patchProvider(editingId, { modelListMode: mode })`；切到 manual 后 UI 切换为手填区，auto 则切回 modelsUrl+拉取按钮 |
| **新增** `addManualModel(id)` / `removeManualModel(id)` | `patchProvider(editingId, { manualModels: [...] })` 维护手填列表 |

### 4.6a 模型列表来源控件（UI 细节）

编辑区里「兜底模型名」下方放一个**模型列表来源**选择器（auto / manual 二选一，按钮组样式，和现有 credentialSource 一致）：

- **auto 模式**（DeepSeek/Anthropic/custom 默认）：显示 `modelsUrl` 输入框 + 「拉取上游模型列表」按钮（现有行为）。拉到的模型显示为 chips，点一下设为兜底值。
- **manual 模式**（智谱默认）：显示一个**手填模型清单**输入区。实现方式：一个文本输入框，回车/逗号分隔追加一个 model tag；每个 tag 可删。底层就是维护 `provider.manualModels: string[]`。

切到 manual 时，UI 不再显示「拉取上游模型列表」按钮（无意义——桥不会联网）。手填列表的 chips 同样可点设为兜底值（`patchProvider(editingId, { model })`）。

> **兜底模型名 vs 手填列表的关系**：手填列表决定「codex 下拉框显示哪些 + resolveModel 认识哪些」，兜底模型名是「codex 发来的模型名不在列表里时用谁顶」。两者独立。manual 模式下用户通常会把兜底设成手填列表里的某一个。

### 4.7 边界细节

1. **列表为空时**：编辑区隐藏，只显示「[+ 新建配置 ▾]」。状态条显示「未选择上游配置」（对应后端 currentProvider()=null 的 503）。
2. **凭证不回显**：每个 provider 的 stored key 仍不回显——`status.credentialReady` 只反映**当前激活 provider** 的 key 就绪状态。编辑非当前 provider 时，用新增的 `backend.bridgeCredentialReady({ providerId })` 显示该 provider 的 key 是否已存（布尔，不是密钥）。

---

## 第 5 部分：测试与验收

### 5.1 测试范围

按 AGENTS.md，测试落在 `tests/` 和 `src/`（co-located）两处。桥多配置改造主要影响 main/protocol 和 shared 层，测试落在 `tests/backend/` 和 `tests/shared/`。

### 5.2 测试清单

| # | 文件 | 覆盖点 | 层 |
|---|---|---|---|
| 1 | `tests/shared/bridge-provider.test.ts` | `createProviderFromPreset` 各预设 → 字段正确填充（尤其 credentialEnvVar、modelListMode、manualModels）、生成唯一 id、BridgeProvider 满足类型；**智谱预设 modelListMode=manual** | shared |
| 2 | `tests/shared/settings-schema-bridge.test.ts` | 新 schema 解析：空对象走 default（enabled=false/providers={}）、provider 记录解析、**旧 `upstream` 字段被静默剥掉不报错** | shared |
| 3 | `tests/backend/bridge-manager-multi-provider.test.ts` | `applySettings` 切 currentProviderId → `currentProvider()` 正确返回；`resolveUpstream`/`resolveCredential` 按 provider.id 查；模型缓存在 current 身份变化时失效、纯改能力不失效 | backend |
| 4 | 同上 | `currentProvider()` 返回 null（enabled 但 currentProviderId='' 或指向不存在的 provider）→ `resolveUpstream` 返回 null | backend |
| 4a | 同上 | **manual 模式**：`listUpstreamModels` 返回 `manualModels` 且设 `knownModelIds`；切到 auto provider 后 `knownModelIds` 来自网络拉取；手填列表变化不进缓存、立即生效 | backend |
| 5 | `tests/backend/bridge-credentials-multi.test.ts` | 多 provider 凭证：不同 id 独立存取、删一个不影响其他、`clearStoredCredential` 精准清 | backend |
| 6 | `tests/ipc/settings-bridge-reconnect.test.ts` | `updateSettings`：开关翻转（codex 在线）→ reconnect；**纯切 provider（enabled 不变）→ 不 reconnect** | ipc |

UI 层（`ProtocolBridgeSection.vue`）仓库无组件测试先例（无 `*.vue.test.ts`），**不引入新测试范式**，靠手动验收。

### 5.3 手动验收脚本

1. 全新 userData（无旧 settings）→ 开桥 → 列表空 → 「新建 DeepSeek」→ 自动选中 + 编辑区出现 DeepSeek 预设值 → 填 key → 保存 → 状态条 credentialReady=true。
2. 再「新建 Anthropic」→ 列表两项 → 切换 radio 到 Anthropic → codex 不重连但模型列表刷新。
3. 删除当前激活的 DeepSeek → currentProviderId 自动落到 Anthropic → 凭证文件里 DeepSeek 的 key 被清（检查 `bridge-credentials.json`）。
4. 关桥 → 列表仍可见，能编辑 → 开桥 → 仍指向关桥前的 currentProviderId。
5. **「新建智谱编程套餐」** → 编辑区出现 baseUrl=`https://open.bigmodel.cn/api/anthropic`、**模型列表来源默认 manual**、手填列表含 glm-5.2/glm-5-turbo/glm-4.7 → 填 key → codex 下拉框显示这三个模型（**全程不联网拉模型**）。
6. 在智谱配置上手填新增一个模型 `glm-4.6v` → codex 下拉框立即出现它（验证 manual 不进缓存、即时生效）。
7. 把某个 provider 从 auto 切到 manual → modelsUrl/拉取按钮消失、手填区出现；切回 → 恢复。
8. `pnpm typecheck` + `pnpm lint` 全过（尤其跨层 import：shared 不能引入 main）。

### 5.4 风险点（设计已覆盖）

| 风险 | 处理 |
|---|---|
| 切 provider 误触发 codex 重连 | settings handler 只在 `enabled` 翻转时重连，纯切 id 不重连（第 3.5） |
| 删 provider 留孤儿 key | UI 删除前 `setBridgeCredential({secret:''})`（第 3.4） |
| 编辑=切换的误设计 | 拆 `editingProviderId` 与 `currentProviderId`（第 4.3） |
| 老 settings.json 残留 `upstream` | 非 strict schema 静默剥除（第 1.2） |
| shared 误引入 main | `createProviderFromPreset` 用全局 `crypto.randomUUID()`，不 `import 'node:crypto'`（第 1.3） |
| manual 模式不设 knownModelIds 导致兜底名误顶 | `listUpstreamModels` manual 分支显式设 `knownModelIds`（第 3.3a） |
| 手填列表改了但 UI 显示旧值 | manual 不进 modelsPromise 缓存，每次重读 manualModels（第 3.3a） |
| 智谱环境变量名和官方 Claude Code 的 ANTHROPIC_AUTH_TOKEN 不一致 | 有意为之：桥内用厂商语义名 ZHIPUAI_API_KEY，避免和 Anthropic 官方混淆（第 1.5） |

---

## 涉及文件清单

| 层 | 文件 | 改动 |
|---|---|---|
| shared | `src/shared/settings-schema.ts` | `protocolBridgeSchema` 改为 providers+currentProviderId；新增 `bridgeProviderSchema`（含 modelListMode/manualModels） |
| shared | `src/shared/protocol/bridge-config.ts` | `BridgeUpstreamConfig` 加 modelListMode/manualModels；新增 `BridgeProvider`、`BridgeSettings` 改形、新增 `createProviderFromPreset`；`BridgeStatus` 加 currentProviderId；**`BRIDGE_UPSTREAM_PRESETS` 新增智谱预设 + 三个旧预设补字段** |
| shared | `src/shared/ipc/backend.ts` | `setBridgeCredential` / `testBridgeUpstream` 加 providerId；新增 `bridgeCredentialReady` 契约 |
| main | `src/main/protocol/manager.ts` | 删 `BRIDGE_CREDENTIAL_ID`；`currentProvider()`；`applySettings`/`resolveUpstream`/`resolveCredential`/`status` 走 currentProvider；**`listUpstreamModels` auto/manual 分叉**；`upstreamModelIdentityChanged` 加 modelListMode/manualModels 比较 |
| main | `src/main/ipc/domains/backend/handlers.ts` | `setBridgeCredential`/`testBridgeUpstream` 用 providerId；新增 `bridgeCredentialReady` handler |
| main | `src/main/ipc/domains/backend/index.ts` | 注册 `bridgeCredentialReady` |
| main | `src/main/ipc/domains/settings/handlers.ts` | 重连条件精确化：只 enabled 翻转才重连 |
| preload | `src/preload/api.ts` | 暴露 `bridgeCredentialReady`；更新 setBridgeCredential/testBridgeUpstream 签名 |
| renderer | `src/renderer/src/components/settings/ProtocolBridgeSection.vue` | 列表+编辑区两层 UI；editing/current 拆分；模型列表来源 auto/manual 控件 + 手填区；新交互函数 |
| test | `tests/shared/bridge-provider.test.ts` | 新增 |
| test | `tests/shared/settings-schema-bridge.test.ts` | 新增 |
| test | `tests/backend/bridge-manager-multi-provider.test.ts` | 新增（含 manual 模式 case） |
| test | `tests/backend/bridge-credentials-multi.test.ts` | 新增 |
| test | `tests/ipc/settings-bridge-reconnect.test.ts` | 新增 |
