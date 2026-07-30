# 协议转换桥多上游配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把协议转换桥从单上游配置改造成多配置（providers 字典 + currentProviderId），支持热切换、手动录入模型列表，并新增智谱编程套餐预设。

**Architecture:** shared 层定义 `BridgeProvider`/`BridgeSettings` 新形状 + `createProviderFromPreset` 工厂；凭证存储层零改动（已按 id 参数化），只把硬编码常量换成 provider.id；BridgeManager 用 `currentProvider()` 取当前配置，`listUpstreamModels` 按 auto/manual 分叉；增删改走 settings.update 主路（不开独立 IPC），凭证读写和 per-provider 就绪查询走独立 IPC；UI 改成 provider 列表 + 编辑区两层，editing 与 current 拆开。

**Tech Stack:** TypeScript + Vue3 + Zod + vitest + Electron IPC（`BackendHandlers` 类型映射 + `handleRendererRequest` + `requestMain` 模式）。

**前置必读：** `docs/superpowers/specs/2026-07-30-protocol-bridge-multi-config-design.md` 是权威设计文档，本计划是其 TDD 实现分解。

**跨层 import 约束（务必遵守）：**
- `shared/` 不能 import `node:*`、`electron`、`main/`、`renderer/`、`preload/`。UUID 生成用全局 `crypto.randomUUID()`（Web Crypto，跨层安全）。
- `renderer/` 不能 import `@main/*`/`@preload/*`/`node:*`/`better-sqlite3`。

**Native 模块提醒：** 跑测试前必须 `pnpm rebuild:node`（better-sqlite3/node-pty 的 Node ABI）。忘了一定是 native binding 错误而非测试失败。

---

## 文件结构

**shared（先做，无依赖）：**
- `src/shared/protocol/bridge-config.ts` — 改 `BridgeUpstreamConfig`（加 modelListMode/manualModels）；新增 `BridgeProvider`/`BridgeModelListMode`；`BridgeSettings`/`BridgeStatus` 改形；`createProviderFromPreset` 工厂；新增智谱预设 + 三个旧预设补字段。
- `src/shared/settings-schema.ts` — `protocolBridgeSchema` 改为 `{ enabled, currentProviderId, providers }`；新增 `bridgeProviderSchema`。
- `src/shared/ipc/backend.ts` — `setBridgeCredential`/`testBridgeUpstream` 加 `providerId`；新增 `backend.bridgeCredentialReady`。
- `src/shared/constants.ts` — 新增 `BACKEND_BRIDGE_CREDENTIAL_READY` channel 常量。

**main（依赖 shared）：**
- `src/main/protocol/manager.ts` — 删 `BRIDGE_CREDENTIAL_ID`；`currentProvider()`；`applySettings`/`resolveUpstream`/`resolveCredential`/`status`/`listUpstreamModels` 走 currentProvider；`upstreamModelIdentityChanged` 扩比较。
- `src/main/backend/builtin-plugins.ts` — codex `applySettings` 的 `upstream.model` 引用改为读当前 provider。
- `src/main/ipc/domains/backend/handlers.ts` — `setBridgeCredential`/`testBridgeUpstream` 用 providerId；新增 `bridgeCredentialReady` handler。
- `src/main/ipc/domains/backend/index.ts` — 注册 `bridgeCredentialReady`。
- `src/main/ipc/domains/settings/handlers.ts` — 重连条件精确化（只 enabled 翻转才重连）。

**preload（依赖 shared）：**
- `src/preload/api.ts` — 暴露 `bridgeCredentialReady`；更新 setBridgeCredential/testBridgeUpstream 签名。

**renderer（依赖 preload + shared）：**
- `src/renderer/src/components/settings/ProtocolBridgeSection.vue` — 列表+编辑区两层 UI；editing/current 拆分；模型列表来源控件 + 手填区。

**test（TDD，与对应实现同任务）：**
- `tests/shared/bridge-provider.test.ts`
- `tests/shared/settings-schema-bridge.test.ts`
- `tests/backend/bridge-manager-multi-provider.test.ts`
- `tests/backend/bridge-credentials-multi.test.ts`
- `tests/ipc/settings-bridge-reconnect.test.ts`

---

## Task 1: 扩展 BridgeUpstreamConfig + 新增 BridgeProvider 类型（shared）

**Files:**
- Modify: `src/shared/protocol/bridge-config.ts`

- [ ] **Step 1: 扩展 BridgeUpstreamConfig，新增 modelListMode/manualModels**

在 `src/shared/protocol/bridge-config.ts` 里，先在 `BridgeCredentialSource` 类型定义之后新增 `BridgeModelListMode`：

```ts
/**
 * 模型列表的获取方式。
 *
 * `auto`：从上游 modelsUrl 拉取（现有行为）；DeepSeek/Anthropic 这类有列表接口的用这个。
 * `manual`：用用户手填的 manualModels，不请求上游；智谱编程套餐等不提供列表接口的厂商用这个。
 */
export type BridgeModelListMode = 'auto' | 'manual'
```

然后在 `BridgeUpstreamConfig` 接口末尾（`capabilities: UpstreamCapabilities` 之后）追加两个字段：

```ts
  /** 模型列表获取方式；auto=拉取上游接口，manual=用手填列表 */
  modelListMode: BridgeModelListMode
  /** modelListMode === 'manual' 时的手填模型 id 列表 */
  manualModels: string[]
```

- [ ] **Step 2: 新增 BridgeProvider 接口 + BridgeSettings 改形**

在 `BridgeUpstreamConfig` 接口定义之后，新增 `BridgeProvider`，并把 `BridgeSettings` 从 `{ enabled; upstream }` 改为新形状：

```ts
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
```

删除旧的 `BridgeSettings` 定义（`{ enabled: boolean; upstream: BridgeUpstreamConfig }`）。

- [ ] **Step 3: BridgeStatus 加 currentProviderId**

在 `BridgeStatus` 接口里，`baseUrl` 之后新增：

```ts
  /** 当前启用的 provider id；null 表示未选任何配置 */
  currentProviderId: string | null
```

- [ ] **Step 4: typecheck 确认 shared 类型层编译过（此时 main/renderer 引用会报错，属预期）**

Run: `pnpm typecheck`
Expected: shared 层自身不报新错；main 的 `manager.ts`/`builtin-plugins.ts`/handlers、renderer 的 `ProtocolBridgeSection.vue` 会因引用旧 `upstream`/`BridgeSettings` 报错——**这些在后续任务修复**。本步只要确认 shared 的类型定义本身无误。

- [ ] **Step 5: Commit**

```bash
git add src/shared/protocol/bridge-config.ts
git commit -m "refactor(bridge): 扩展 BridgeUpstreamConfig 模型列表字段，新增 BridgeProvider/BridgeSettings 新形状"
```

---

## Task 2: 新增智谱预设 + 三个旧预设补字段 + createProviderFromPreset 工厂（shared）

**Files:**
- Modify: `src/shared/protocol/bridge-config.ts`

- [ ] **Step 1: 给三个旧预设的 config 补 modelListMode/manualModels**

在 `BRIDGE_UPSTREAM_PRESETS` 数组里，deepseek / anthropic / custom 三个预设的 `config` 对象末尾（`capabilities` 之后）各补两行：

```ts
      modelListMode: 'auto',
      manualModels: [],
```

（custom 预设的 `config` 也补这两行，虽然 baseUrl 空，但它仍是 auto 模式——用户填好地址后会去拉。）

- [ ] **Step 2: 新增智谱编程套餐预设**

在 `BRIDGE_UPSTREAM_PRESETS` 数组里，`custom` 预设**之前**插入智谱预设：

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
      // 套餐不提供列表接口，manual 模式用手填列表
      modelsUrl: '',
      model: 'glm-5.2',
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
      manualModels: ['glm-5.2', 'glm-5-turbo', 'glm-4.7'],
    },
  },
```

- [ ] **Step 3: 新增 createProviderFromPreset 工厂函数**

在 `bridgeUpstreamPreset` 函数定义之后，新增：

```ts
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
```

- [ ] **Step 4: 删除 DEFAULT_BRIDGE_UPSTREAM（已无消费者）**

`DEFAULT_BRIDGE_UPSTREAM` 原本是 ProtocolBridgeSection.vue 的占位兜底。新 schema 有了 default，UI 不再需要它。删除 `DEFAULT_BRIDGE_UPSTREAM` 常量定义（约在 `bridgeUpstreamPreset` 之后）。**注意**：renderer 的 `ProtocolBridgeSection.vue` 还 import 了它，本步删除后 typecheck 会报 renderer 引用错——在 Task 9 重写 UI 时消除。若想本步 typecheck 干净，可暂留待 Task 9 删；但既然 Task 9 会整块重写该 import，**现在删**更彻底。

- [ ] **Step 5: typecheck**

Run: `pnpm typecheck`
Expected: shared 层编译过；manager/builtin-plugins/handlers/UI 的旧引用报错继续存在（后续任务修）。

- [ ] **Step 6: Commit**

```bash
git add src/shared/protocol/bridge-config.ts
git commit -m "feat(bridge): 新增智谱编程套餐预设，补全旧预设模型列表字段，加 createProviderFromPreset 工厂"
```

---

## Task 3: TDD — bridge-config 工厂与预设（shared）

**Files:**
- Create: `tests/shared/bridge-provider.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/shared/bridge-provider.test.ts`：

```ts
// @vitest-environment node
import { describe, expect, test } from 'vitest'

import {
  BRIDGE_UPSTREAM_PRESETS,
  bridgeUpstreamPreset,
  createProviderFromPreset,
} from '@shared/protocol/bridge-config'

describe('createProviderFromPreset', () => {
  test('各预设生成的 provider 字段正确填充', () => {
    for (const preset of BRIDGE_UPSTREAM_PRESETS) {
      const provider = createProviderFromPreset(preset.id)
      expect(provider.id).toBeTruthy()
      expect(provider.presetId).toBe(preset.id)
      expect(provider.name).toBe(preset.label)
      expect(typeof provider.createdAt).toBe('number')
      // 模型列表字段必填
      expect(['auto', 'manual']).toContain(provider.modelListMode)
      expect(Array.isArray(provider.manualModels)).toBe(true)
      // 凭证来源默认 stored
      expect(provider.credentialSource).toBe('stored')
      // 预设的 baseUrl/protocol 透传
      expect(provider.baseUrl).toBe(preset.config.baseUrl)
      expect(provider.protocol).toBe(preset.config.protocol)
    }
  })

  test('智谱预设有 modelListMode=manual 且预填模型', () => {
    const provider = createProviderFromPreset('zhipu')
    expect(provider.modelListMode).toBe('manual')
    expect(provider.manualModels).toEqual(['glm-5.2', 'glm-5-turbo', 'glm-4.7'])
    expect(provider.baseUrl).toBe('https://open.bigmodel.cn/api/anthropic')
    expect(provider.model).toBe('glm-5.2')
    expect(provider.credentialEnvVar).toBe('ZHIPUAI_API_KEY')
  })

  test('deepseek/anthropic/custom 预设是 auto 模式', () => {
    for (const id of ['deepseek', 'anthropic', 'custom']) {
      expect(createProviderFromPreset(id).modelListMode).toBe('auto')
    }
  })

  test('credentialSource 参数透传', () => {
    expect(createProviderFromPreset('deepseek', 'env').credentialSource).toBe('env')
  })

  test('未知 presetId 回退到 custom', () => {
    const provider = createProviderFromPreset('不存在的预设')
    expect(provider.presetId).toBe('custom')
  })

  test('每次调用生成不同的 id', () => {
    const a = createProviderFromPreset('deepseek')
    const b = createProviderFromPreset('deepseek')
    expect(a.id).not.toBe(b.id)
  })

  test('bridgeUpstreamPreset 能查到智谱', () => {
    expect(bridgeUpstreamPreset('zhipu')?.id).toBe('zhipu')
  })
})
```

- [ ] **Step 2: 跑测试确认通过**

Run: `pnpm rebuild:node && npx vitest run tests/shared/bridge-provider.test.ts`
Expected: PASS（Task 2 已实现，测试应直接绿）。

- [ ] **Step 3: Commit**

```bash
git add tests/shared/bridge-provider.test.ts
git commit -m "test(bridge): 覆盖 createProviderFromPreset 各预设与智谱 manual 模式"
```

---

## Task 4: 改 protocolBridge Zod schema（shared）

**Files:**
- Modify: `src/shared/settings-schema.ts`

- [ ] **Step 1: 替换 protocolBridgeSchema**

在 `src/shared/settings-schema.ts` 里，找到 `protocolBridgeSchema` 定义（约 70-86 行），整块替换为：

```ts
const bridgeProviderSchema = z.object({
  id: z.string(),
  name: z.string().default(''),
  presetId: z.string().default('custom'),
  createdAt: z.number().int().default(0),
  protocol: z.enum(['anthropic.messages']).default('anthropic.messages'),
  baseUrl: z.string().default(''),
  /** 模型列表端点完整 URL；常与 baseUrl 不同路径（见 bridge-config.ts） */
  modelsUrl: z.string().default(''),
  model: z.string().nullable().default(null),
  credentialSource: z.enum(['env', 'stored']).default('stored'),
  credentialEnvVar: z.string().default(''),
  capabilities: upstreamCapabilitiesSchema.default({}),
  modelListMode: z.enum(['auto', 'manual']).default('auto'),
  manualModels: z.array(z.string()).default([]),
})

const protocolBridgeSchema = z.object({
  enabled: z.boolean().default(false),
  /** 当前启用的 provider id；为空字符串表示未选任何配置 */
  currentProviderId: z.string().default(''),
  providers: z.record(z.string(), bridgeProviderSchema).default({}),
})
```

`ProtocolBridgeSettings` 的 `z.infer` 导出保持不变（它会自动反映新形状）。

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: shared 编译过；`settings-schema.ts` 本身无错。

- [ ] **Step 3: Commit**

```bash
git add src/shared/settings-schema.ts
git commit -m "refactor(bridge): protocolBridge schema 改为 providers 字典 + currentProviderId"
```

---

## Task 5: TDD — settings schema 解析（含旧字段静默剥除）

**Files:**
- Create: `tests/shared/settings-schema-bridge.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/shared/settings-schema-bridge.test.ts`：

```ts
// @vitest-environment node
import { describe, expect, test } from 'vitest'

import { appSettingsSchema } from '@shared/settings-schema'

describe('protocolBridge schema', () => {
  test('空对象走 default：enabled=false, currentProviderId="", providers={}', () => {
    const parsed = appSettingsSchema.parse({}).protocolBridge
    expect(parsed.enabled).toBe(false)
    expect(parsed.currentProviderId).toBe('')
    expect(parsed.providers).toEqual({})
  })

  test('provider 记录正确解析，含 modelListMode/manualModels', () => {
    const parsed = appSettingsSchema.parse({
      protocolBridge: {
        enabled: true,
        currentProviderId: 'p1',
        providers: {
          p1: {
            id: 'p1',
            name: '我的 DeepSeek',
            presetId: 'deepseek',
            createdAt: 1000,
            protocol: 'anthropic.messages',
            baseUrl: 'https://api.deepseek.com/anthropic',
            modelsUrl: 'https://api.deepseek.com/models',
            model: 'deepseek-v4-pro',
            credentialSource: 'stored',
            credentialEnvVar: 'DEEPSEEK_API_KEY',
            capabilities: { supportsImages: false },
            modelListMode: 'manual',
            manualModels: ['a', 'b'],
          },
        },
      },
    }).protocolBridge
    expect(parsed.providers.p1.modelListMode).toBe('manual')
    expect(parsed.providers.p1.manualModels).toEqual(['a', 'b'])
    expect(parsed.providers.p1.capabilities.supportsImages).toBe(false)
  })

  test('旧 upstream 字段被静默剥掉不报错（向后兼容）', () => {
    // 旧 settings.json 残留 upstream/presetId，新 schema 非 strict 会剥除
    const parsed = appSettingsSchema.parse({
      protocolBridge: {
        enabled: true,
        presetId: 'deepseek',
        upstream: { baseUrl: 'https://old.example.com', protocol: 'anthropic.messages' },
      },
    }).protocolBridge
    // 新字段走 default
    expect(parsed.currentProviderId).toBe('')
    expect(parsed.providers).toEqual({})
    // 旧字段不存在于解析结果
    expect((parsed as unknown as Record<string, unknown>).upstream).toBeUndefined()
    expect((parsed as unknown as Record<string, unknown>).presetId).toBeUndefined()
  })

  test('provider 缺 modelListMode 时走 default auto', () => {
    const parsed = appSettingsSchema.parse({
      protocolBridge: {
        providers: { p1: { id: 'p1', baseUrl: 'x', protocol: 'anthropic.messages' } },
      },
    }).protocolBridge
    expect(parsed.providers.p1.modelListMode).toBe('auto')
    expect(parsed.providers.p1.manualModels).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认通过**

Run: `pnpm rebuild:node && npx vitest run tests/shared/settings-schema-bridge.test.ts`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add tests/shared/settings-schema-bridge.test.ts
git commit -m "test(bridge): 覆盖新 schema 解析与旧 upstream 字段静默剥除"
```

---

## Task 6: 改 BridgeManager — currentProvider / applySettings / resolve* / listUpstreamModels（main）

**Files:**
- Modify: `src/main/protocol/manager.ts`

这是改动最大的文件。逐方法改。

- [ ] **Step 1: 删 BRIDGE_CREDENTIAL_ID 常量**

删除 `manager.ts` 里这行（约 33-34 行）：

```ts
/** 凭证存储里的 key 名 */
export const BRIDGE_CREDENTIAL_ID = 'codex-bridge'
```

同时更新 import：`BridgeSettings` 已是新形状，无需改 import 语句（类型名没变）；但 `BridgeUpstreamConfig` 的 import 可能不再直接需要——若 `upstreamModelIdentityChanged` 签名仍用它则保留。

- [ ] **Step 2: 加 currentProvider() 方法 + 改 import 类型**

在 `BridgeManager` 类里，`private readonly server` 之后、`applySettings` 之前，新增：

```ts
  /** 当前激活的 provider；未选/不存在时返回 null */
  private currentProvider(): BridgeProvider | null {
    const s = this.settings
    if (!s) return null
    const id = s.currentProviderId
    if (!id) return null
    return s.providers[id] ?? null
  }
```

在文件顶部 import 里加上 `BridgeProvider`：

```ts
import {
  BRIDGE_CODEX_PROVIDER_ID,
  BRIDGE_TOKEN_ENV_VAR,
  type BridgeModelInfo,
  type BridgeProvider,
  type BridgeSettings,
  type BridgeStatus,
  type BridgeUpstreamConfig,
} from '@shared/protocol/bridge-config'
```

- [ ] **Step 3: 改 applySettings — 用 currentProvider 比较**

把 `applySettings` 方法整块替换为：

```ts
  /** settings 变化时调用：按 enabled 起停服务 */
  async applySettings(settings: BridgeSettings): Promise<void> {
    const wasEnabled = this.settings?.enabled ?? false
    const prevCurrent = this.currentProvider() // 切换前的当前 provider 快照
    this.settings = settings
    const newCurrent = this.currentProvider()

    // 当前 provider 的「身份」变了（地址/列表/凭证来源/模型列表模式/手填列表）就丢模型缓存
    if (
      (prevCurrent && newCurrent && upstreamModelIdentityChanged(prevCurrent, newCurrent)) ||
      (!prevCurrent && newCurrent)
    ) {
      this.invalidateModels()
    }

    if (settings.enabled && !wasEnabled) {
      try {
        await this.server.start()
      } catch (error) {
        log.warn('桥启动失败', error instanceof Error ? error.message : String(error))
      }
      return
    }
    if (!settings.enabled && wasEnabled) {
      await this.server.stop()
    }
  }
```

- [ ] **Step 4: 改 resolveUpstream — 走 currentProvider**

把 `resolveUpstream` 方法整块替换为：

```ts
  private resolveUpstream(): BridgeUpstreamTarget | null {
    const upstream = this.currentProvider()
    if (!this.settings?.enabled || !upstream) return null
    if (!upstream.baseUrl.trim()) return null

    const apiKey = this.resolveCredential()
    if (!apiKey) return null

    return {
      protocol: upstream.protocol,
      baseUrl: upstream.baseUrl.trim(),
      apiKey,
      model: upstream.model?.trim() ? upstream.model.trim() : null,
      knownModelIds: this.knownModelIds,
      capabilities: upstream.capabilities,
    }
  }
```

- [ ] **Step 5: 改 resolveCredential — 按 provider.id 查凭证**

把 `resolveCredential` 方法整块替换为：

```ts
  private resolveCredential(): string | null {
    const provider = this.currentProvider()
    if (!provider) return null
    if (provider.credentialSource === 'env') {
      const name = provider.credentialEnvVar.trim()
      if (!name) return null
      const value = process.env[name]?.trim()
      return value ? value : null
    }
    return getStoredCredential(provider.id)
  }
```

- [ ] **Step 6: 改 listUpstreamModels — auto/manual 分叉**

把 `listUpstreamModels` 方法整块替换为：

```ts
  async listUpstreamModels(): Promise<BridgeModelInfo[]> {
    // manual 模式不进缓存：手填列表随时可变，每次重读保证即时生效
    const provider = this.currentProvider()
    if (!provider) return []

    if (provider.modelListMode === 'manual') {
      const models = provider.manualModels
        .map((id) => id.trim())
        .filter((id) => id)
        .map((id) => ({ id, displayName: id }))
      // 手填列表也要喂给 knownModelIds——resolveModel 据此判断透传还是兜底
      this.knownModelIds = new Set(models.map((m) => m.id))
      return models
    }

    // auto 模式：缓存命中优先
    if (this.modelsPromise) return this.modelsPromise
    if (!this.settings?.enabled) return []
    const { baseUrl, modelsUrl } = provider
    const apiKey = this.resolveCredential()
    if (!apiKey) return []

    this.modelsPromise = (async () => {
      try {
        const models = await fetchUpstreamModels({ modelsUrl, baseUrl, apiKey })
        this.knownModelIds = new Set(models.map((m) => m.id))
        return models
      } catch (error) {
        this.modelsPromise = null
        log.warn('拉取上游模型列表失败', error instanceof Error ? error.message : String(error))
        return []
      }
    })()
    return this.modelsPromise
  }
```

- [ ] **Step 7: 改 status — 加 currentProviderId，走 currentProvider**

把 `status` 方法整块替换为：

```ts
  status(): BridgeStatus {
    const provider = this.currentProvider()
    return {
      running: this.server.running,
      port: this.server.listenPort,
      baseUrl: this.server.baseUrl,
      currentProviderId: provider?.id ?? null,
      upstreamProtocol: provider?.protocol ?? null,
      upstreamBaseUrl: provider?.baseUrl ?? null,
      credentialReady: this.credentialReady(),
      lastError: this.server.error,
    }
  }
```

- [ ] **Step 8: 改 upstreamModelIdentityChanged — 加 modelListMode/manualModels 比较**

把文件末尾的 `upstreamModelIdentityChanged` 函数替换为：

```ts
/**
 * 影响「模型列表是哪个上游的」的字段变了没有。
 * 改能力开关（supportsImages 等）不该丢缓存；但地址/列表/凭证来源/模型列表模式/手填列表变了要丢。
 */
function upstreamModelIdentityChanged(a: BridgeUpstreamConfig, b: BridgeUpstreamConfig): boolean {
  return (
    a.modelsUrl !== b.modelsUrl ||
    a.baseUrl !== b.baseUrl ||
    a.credentialSource !== b.credentialSource ||
    a.credentialEnvVar !== b.credentialEnvVar ||
    a.modelListMode !== b.modelListMode ||
    // manualModels 按内容比（引用不同但内容相同不该失效）
    a.manualModels.join('\n') !== b.manualModels.join('\n')
  )
}
```

- [ ] **Step 9: typecheck（manager 自身应通过，但 builtin-plugins/handlers 仍报错属预期）**

Run: `pnpm typecheck`
Expected: `manager.ts` 自身无错。

- [ ] **Step 10: Commit**

```bash
git add src/main/protocol/manager.ts
git commit -m "refactor(bridge): BridgeManager 改走 currentProvider，listUpstreamModels auto/manual 分叉"
```

---

## Task 7: 修 builtin-plugins codex applySettings 的 upstream 引用（main）

**Files:**
- Modify: `src/main/backend/builtin-plugins.ts`

- [ ] **Step 1: 改 codex applySettings 的 model list provider**

`builtin-plugins.ts:56` 仍引用 `settings.protocolBridge.upstream.model`（已不存在）。把 `setModelListProvider` 调用里的 `list` 闭包改读当前 provider 的兜底模型。找到 `setModelListProvider(...)` 块（约 48-68 行），整块替换为：

```ts
        adapter.setModelListProvider(
          settings.protocolBridge.enabled
            ? {
                list: async () => {
                  const models = await bridgeManager.listUpstreamModels()
                  if (models.length === 0) return []
                  // 默认项优先用当前 provider 的兜底模型；不在上游列表就退到第一个
                  const currentId = settings.protocolBridge.currentProviderId
                  const provider = settings.protocolBridge.providers[currentId]
                  const fallback = provider?.model?.trim()
                  const defaultId =
                    fallback && models.some((m) => m.id === fallback) ? fallback : models[0]!.id
                  return models.map((model) => ({
                    id: model.id,
                    displayName: model.displayName,
                    ...(model.id === defaultId ? { isDefault: true } : {}),
                  }))
                },
                invalidate: () => bridgeManager.invalidateModels(),
              }
            : null,
        )
```

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: `builtin-plugins.ts` 无错。

- [ ] **Step 3: Commit**

```bash
git add src/main/backend/builtin-plugins.ts
git commit -m "fix(bridge): codex applySettings 改读当前 provider 的兜底模型"
```

---

## Task 8: 改 IPC 契约 — setBridgeCredential/testBridgeUpstream 加 providerId + bridgeCredentialReady（shared + main + preload）

**Files:**
- Modify: `src/shared/constants.ts`
- Modify: `src/shared/ipc/backend.ts`
- Modify: `src/main/ipc/domains/backend/handlers.ts`
- Modify: `src/main/ipc/domains/backend/index.ts`
- Modify: `src/preload/api.ts`

- [ ] **Step 1: constants.ts 加 channel 常量**

在 `src/shared/constants.ts` 里 `BACKEND_TEST_BRIDGE_UPSTREAM` 之后（约 68 行后）新增：

```ts
  BACKEND_BRIDGE_CREDENTIAL_READY: 'backend.bridgeCredentialReady',
```

- [ ] **Step 2: backend.ts 契约改签名 + 加新方法**

在 `src/shared/ipc/backend.ts` 里，把这三行（约 109-111）替换：

```ts
  'backend.setBridgeCredential': (args: { secret: string }) => Promise<BridgeStatus>
  /** 用当前配置打一次上游，验证 base_url / key / 模型名是否可用 */
  'backend.testBridgeUpstream': () => Promise<{ ok: boolean; message: string }>
```

替换为：

```ts
  'backend.setBridgeCredential': (args: {
    providerId: string
    secret: string
  }) => Promise<BridgeStatus>
  /** 用指定 provider 的配置打一次上游，验证 base_url / key / 模型名是否可用 */
  'backend.testBridgeUpstream': (args: { providerId: string }) => Promise<{
    ok: boolean
    message: string
  }>
  /** 查询指定 provider 的凭证是否已就绪（只回布尔，不回传密钥） */
  'backend.bridgeCredentialReady': (args: { providerId: string }) => Promise<boolean>
```

- [ ] **Step 3: handlers.ts 改 setBridgeCredential / testBridgeUpstream + 新增 bridgeCredentialReady**

在 `src/main/ipc/domains/backend/handlers.ts` 里：

把 `setBridgeCredential`（约 190-202）替换为：

```ts
export const setBridgeCredential = async (args: {
  providerId: string
  secret: string
}): Promise<BridgeStatus> => {
  setStoredCredential(args.providerId, args.secret.trim())
  bridgeManager.invalidateModels()
  const status = bridgeManager.status()
  // 常见场景：codex 早于桥 spawn（启动时桥关着），没拿到 `-c model_provider` 参数。
  // 保存 key 是用户完成桥配置的时刻——桥此时若已在跑，借机让 codex 重 spawn 带上 -c。
  if (status.running && ctx.backendManager.getCurrentId() === 'codex') {
    void ctx.backendManager.reconnectBackend('codex')
  }
  return status
}
```

把 `testBridgeUpstream`（约 210-250）替换为：

```ts
export const testBridgeUpstream = async (args: {
  providerId: string
}): Promise<{ ok: boolean; message: string }> => {
  const settings = ctx.settingsStore.load().protocolBridge
  const provider = settings.providers[args.providerId]
  if (!provider) return { ok: false, message: '配置不存在' }
  if (!provider.baseUrl.trim()) return { ok: false, message: '还没填上游地址' }

  // 取该 provider 的凭证做自检（env 读环境变量，stored 读 0600 文件）
  let apiKey: string | null = null
  if (provider.credentialSource === 'env') {
    const name = provider.credentialEnvVar.trim()
    apiKey = name ? (process.env[name]?.trim() || null) : null
  } else {
    apiKey = getStoredCredential(args.providerId)
  }
  if (!apiKey) {
    return {
      ok: false,
      message:
        provider.credentialSource === 'env'
          ? `环境变量 ${provider.credentialEnvVar || '(未填)'} 是空的`
          : '还没保存 API key',
    }
  }

  const codec = getCodec(provider.protocol)
  const base = provider.baseUrl.trim().replace(/\/+$/, '')
  const path = codec.upstreamPath()
  const url = base + (/\/v\d+$/.test(base) ? path.replace(/^\/v\d+/, '') : path)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...codec.authHeaders(apiKey) },
      body: JSON.stringify({
        model: provider.model?.trim() || 'claude-sonnet-4-20250514',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (response.ok) return { ok: true, message: `连通正常（HTTP ${response.status}）` }
    const detail = await response.text().catch(() => '')
    return { ok: false, message: `HTTP ${response.status}：${detail.slice(0, 300)}` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `请求失败：${message}` }
  }
}
```

在文件末尾新增：

```ts
export const bridgeCredentialReady = async (args: {
  providerId: string
}): Promise<boolean> => {
  const settings = ctx.settingsStore.load().protocolBridge
  const provider = settings.providers[args.providerId]
  if (!provider) return false
  if (provider.credentialSource === 'env') {
    const name = provider.credentialEnvVar.trim()
    return name ? !!process.env[name]?.trim() : false
  }
  return getStoredCredential(args.providerId) !== null
}
```

**调整 import**（本步关键）：handlers.ts 现有 `import { bridgeManager, BRIDGE_CREDENTIAL_ID } from '@main/protocol/manager'`（Task 6 已删 `BRIDGE_CREDENTIAL_ID` 导出，留着这个 import 会编译错）和 `import { setStoredCredential } from '@main/service/bridge-credentials'`。改为：

```ts
import { bridgeManager } from '@main/protocol/manager'
```

（去掉 `BRIDGE_CREDENTIAL_ID`）。并把 bridge-credentials 的 import 扩成：

```ts
import { getStoredCredential, setStoredCredential } from '@main/service/bridge-credentials'
```

（新增 `getStoredCredential`——testBridgeUpstream 和 bridgeCredentialReady 都要用）。

- [ ] **Step 4: index.ts 注册 bridgeCredentialReady**

在 `src/main/ipc/domains/backend/index.ts` 里，import 加 `bridgeCredentialReady`：

```ts
import {
  // ... 现有 imports
  bridgeCredentialReady,
  // ...
} from './handlers'
```

在 `registerBackendHandlers` 末尾（`testBridgeUpstream` 注册之后）加：

```ts
  handleRendererRequest<BackendHandlers, 'backend.bridgeCredentialReady'>(
    'backend.bridgeCredentialReady',
    bridgeCredentialReady,
  )
```

- [ ] **Step 5: preload/api.ts 暴露 bridgeCredentialReady**

在 `src/preload/api.ts` 里，`testBridgeUpstream` 之后（约 106 行后）加：

```ts
    bridgeCredentialReady: requestMain<BackendHandlers, 'backend.bridgeCredentialReady'>(
      IPC.BACKEND_BRIDGE_CREDENTIAL_READY,
    ),
```

- [ ] **Step 6: typecheck**

Run: `pnpm typecheck`
Expected: shared/main/preload 全通过（renderer 的 ProtocolBridgeSection.vue 仍报错，Task 9 修）。

- [ ] **Step 7: Commit**

```bash
git add src/shared/constants.ts src/shared/ipc/backend.ts src/main/ipc/domains/backend/handlers.ts src/main/ipc/domains/backend/index.ts src/preload/api.ts
git commit -m "feat(bridge): setBridgeCredential/testBridgeUpstream 加 providerId，新增 bridgeCredentialReady IPC"
```

---

## Task 9: 改 settings handler 重连条件（main）

**Files:**
- Modify: `src/main/ipc/domains/settings/handlers.ts`

- [ ] **Step 1: 精确化重连条件 — 只 enabled 翻转才重连**

`updateSettings` 里（约 29-56）把重连判断改为只比较 enabled。把整个 `updateSettings` 函数替换为：

```ts
export const updateSettings = async (args: {
  patch: Partial<AppSettings>
}): Promise<AppSettings> => {
  // 桥开关翻转要重连 codex——它的 -c 参数依赖桥的端口/token，
  // 已 spawn 的进程读不到新值。必须在 update 前快照旧值才能 diff。
  // 注意：纯切 provider（currentProviderId 变、enabled 不变）不需要重连——
  // codexSpawnArgs 返回不变（端口/token 没变），桥的 resolveUpstream 每次请求重读。
  const wasBridgeEnabled = ctx.settingsStore.load().protocolBridge.enabled
  const updated = ctx.settingsStore.update(args.patch)
  await applyBridgeThenBackend(updated)
  if (
    updated.protocolBridge.enabled !== wasBridgeEnabled &&
    ctx.backendManager.getCurrentId() === 'codex'
  ) {
    try {
      await ctx.backendManager.reconnectBackend('codex')
    } catch (e) {
      log.warn('bridge toggle: codex reconnect failed, will respawn on next turn:', e)
    }
  }
  return updated
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: `handlers.ts` 无错。

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc/domains/settings/handlers.ts
git commit -m "fix(bridge): updateSettings 只在桥开关翻转时重连 codex，纯切 provider 不重连"
```

---

## Task 10: TDD — bridge manager 多 provider + manual 模式

**Files:**
- Create: `tests/backend/bridge-manager-multi-provider.test.ts`

- [ ] **Step 1: 写测试（mock server / credentials）**

创建 `tests/backend/bridge-manager-multi-provider.test.ts`：

```ts
// @vitest-environment node
import type { BridgeSettings, BridgeProvider } from '@shared/protocol/bridge-config'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// mock bridge-credentials（避免碰真实 userData）
vi.mock('@main/service/bridge-credentials', () => ({
  getStoredCredential: vi.fn((id: string) => (id === 'stored-ready' ? 'fake-key' : null)),
}))

const { BridgeManager } = await import('@main/protocol/manager')

function makeProvider(over: Partial<BridgeProvider> = {}): BridgeProvider {
  return {
    id: 'p1',
    name: 'test',
    presetId: 'custom',
    createdAt: 1,
    protocol: 'anthropic.messages',
    baseUrl: 'https://up.example.com',
    modelsUrl: '',
    model: 'm1',
    credentialSource: 'stored',
    credentialEnvVar: '',
    capabilities: {
      supportsImages: true,
      dropSamplingWhenThinking: true,
      defaultMaxOutputTokens: 8192,
      toolNameMaxLength: 64,
    },
    modelListMode: 'manual',
    manualModels: ['m1', 'm2'],
    ...over,
  }
}

function makeSettings(
  providers: Record<string, BridgeProvider>,
  currentProviderId: string,
  enabled = true,
): BridgeSettings {
  return { enabled, currentProviderId, providers }
}

describe('BridgeManager 多 provider', () => {
  let mgr: InstanceType<typeof BridgeManager>

  beforeEach(() => {
    mgr = new BridgeManager()
  })

  test('currentProvider 返回 currentProviderId 指向的 provider', async () => {
    const p1 = makeProvider({ id: 'p1' })
    const p2 = makeProvider({ id: 'p2', name: 'other' })
    await mgr.applySettings(makeSettings({ p1, p2 }, 'p2'))
    // 通过 status().currentProviderId 间接验证
    expect(mgr.status().currentProviderId).toBe('p2')
  })

  test('currentProviderId 指向不存在的 provider 时 status.currentProviderId 为 null', async () => {
    await mgr.applySettings(makeSettings({ p1: makeProvider() }, 'nope'))
    expect(mgr.status().currentProviderId).toBeNull()
  })

  test('currentProviderId 为空时 upstreamBaseUrl 为 null', async () => {
    await mgr.applySettings(makeSettings({ p1: makeProvider() }, ''))
    expect(mgr.status().upstreamBaseUrl).toBeNull()
  })

  test('manual 模式 listUpstreamModels 返回手填列表，不联网', async () => {
    const p1 = makeProvider({ id: 'p1', manualModels: ['GLM-5.2', 'glm-4.6v'] })
    await mgr.applySettings(makeSettings({ p1 }, 'p1'))
    const models = await mgr.listUpstreamModels()
    expect(models.map((m) => m.id)).toEqual(['GLM-5.2', 'glm-4.6v'])
  })

  test('manual 模式空凭证时 listUpstreamModels 仍返回手填列表', async () => {
    // manual 不依赖凭证（凭证只影响实际转发请求）
    const p1 = makeProvider({ id: 'no-cred', manualModels: ['x'] })
    await mgr.applySettings(makeSettings({ p1 }, 'no-cred'))
    const models = await mgr.listUpstreamModels()
    expect(models.map((m) => m.id)).toEqual(['x'])
  })

  test('resolveCredential 按 provider.id 查凭证（stored）', async () => {
    const p1 = makeProvider({ id: 'stored-ready' }) // mock 返回 fake-key
    await mgr.applySettings(makeSettings({ p1 }, 'stored-ready'))
    expect(mgr.status().credentialReady).toBe(true)
  })

  test('stored 凭证缺失时 credentialReady 为 false', async () => {
    const p1 = makeProvider({ id: 'no-key' })
    await mgr.applySettings(makeSettings({ p1 }, 'no-key'))
    expect(mgr.status().credentialReady).toBe(false)
  })

  test('env 凭证：读环境变量', async () => {
    process.env.TEST_BRIDGE_KEY = 'env-value'
    const p1 = makeProvider({
      id: 'env-p',
      credentialSource: 'env',
      credentialEnvVar: 'TEST_BRIDGE_KEY',
    })
    await mgr.applySettings(makeSettings({ p1 }, 'env-p'))
    expect(mgr.status().credentialReady).toBe(true)
    delete process.env.TEST_BRIDGE_KEY
  })

  test('切 provider 后手填列表内容变化即时生效（不进缓存）', async () => {
    const p1 = makeProvider({ id: 'p1', manualModels: ['a'] })
    await mgr.applySettings(makeSettings({ p1 }, 'p1'))
    expect((await mgr.listUpstreamModels()).map((m) => m.id)).toEqual(['a'])
    // 改手填列表再 apply
    const p1b = { ...p1, manualModels: ['a', 'b', 'c'] }
    await mgr.applySettings(makeSettings({ p1: p1b }, 'p1'))
    expect((await mgr.listUpstreamModels()).map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })
})
```

- [ ] **Step 2: 跑测试确认通过**

Run: `pnpm rebuild:node && npx vitest run tests/backend/bridge-manager-multi-provider.test.ts`
Expected: PASS。若 `applySettings` 在 enabled 时尝试 `server.start()` 失败（测试环境无端口），manager 内部已 try/catch 仅 log.warn，不影响断言。

- [ ] **Step 3: Commit**

```bash
git add tests/backend/bridge-manager-multi-provider.test.ts
git commit -m "test(bridge): 覆盖多 provider currentProvider 解析与 manual 模式列表"
```

---

## Task 11: TDD — 多 provider 凭证存储独立

**Files:**
- Create: `tests/backend/bridge-credentials-multi.test.ts`

- [ ] **Step 1: 写测试（用临时 userData）**

创建 `tests/backend/bridge-credentials-multi.test.ts`：

```ts
// @vitest-environment node
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

// 让 bridge-credentials 用临时目录（app.getPath 在测试里会抛，它自己已退回 TMPDIR）
const tmpDir = join(process.env.TMPDIR ?? '/tmp', `catmax-cred-test-${Date.now()}`)

const { setStoredCredential, getStoredCredential, clearStoredCredential, hasStoredCredential } =
  await import('@main/service/bridge-credentials')

describe('bridge-credentials 多 provider 独立', () => {
  afterEach(() => {
    // 清掉本测试写入的 key
    for (const id of ['p1', 'p2', 'p3']) clearStoredCredential(id)
  })

  test('不同 id 独立存取', () => {
    setStoredCredential('p1', 'key-a')
    setStoredCredential('p2', 'key-b')
    expect(getStoredCredential('p1')).toBe('key-a')
    expect(getStoredCredential('p2')).toBe('key-b')
  })

  test('删一个不影响其他', () => {
    setStoredCredential('p1', 'key-a')
    setStoredCredential('p2', 'key-b')
    clearStoredCredential('p1')
    expect(getStoredCredential('p1')).toBeNull()
    expect(getStoredCredential('p2')).toBe('key-b')
  })

  test('传空串即清除', () => {
    setStoredCredential('p3', 'key-c')
    setStoredCredential('p3', '')
    expect(getStoredCredential('p3')).toBeNull()
    expect(hasStoredCredential('p3')).toBe(false)
  })

  test('不存在的 id 返回 null', () => {
    expect(getStoredCredential('never-set')).toBeNull()
    expect(hasStoredCredential('never-set')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认通过**

Run: `pnpm rebuild:node && npx vitest run tests/backend/bridge-credentials-multi.test.ts`
Expected: PASS（存储层本就按 id 参数化，本测试验证这一点未被破坏）。

- [ ] **Step 3: Commit**

```bash
git add tests/backend/bridge-credentials-multi.test.ts
git commit -m "test(bridge): 验证凭证存储多 id 独立存取"
```

---

## Task 12: TDD — settings 重连只在开关翻转时触发

**Files:**
- Create: `tests/ipc/settings-bridge-reconnect.test.ts`

- [ ] **Step 1: 写测试**

创建 `tests/ipc/settings-bridge-reconnect.test.ts`。这个测试验证 `updateSettings` 的重连条件逻辑——因为直接测 handler 需要完整 ctx，改用单元测试抽出的纯函数思路太重。**简化做法**：测 `wasBridgeEnabled !== nowBridgeEnabled` 这个判断本身，通过 spy 验证 reconnect 只在 enabled 翻转时被调。

```ts
// @vitest-environment node
//
// 验证 updateSettings 的重连逻辑：开关翻转才重连 codex，纯切 provider 不重连。
// 用 mock 的 ctx + settingsStore + backendManager 隔离真实依赖。
import type { AppSettings } from '@shared/settings-schema'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  applySettings: vi.fn(async () => {}),
  load: vi.fn(),
  update: vi.fn(),
  getCurrentId: vi.fn(() => 'codex'),
  reconnectBackend: vi.fn(async () => {}),
}))

vi.mock('@main/context', () => ({
  ctx: {
    settingsStore: { load: mocks.load, update: mocks.update },
    backendManager: {
      applySettings: mocks.applySettings,
      getCurrentId: mocks.getCurrentId,
      reconnectBackend: mocks.reconnectBackend,
    },
  },
}))

vi.mock('@main/protocol/manager', () => ({
  bridgeManager: { applySettings: vi.fn(async () => {}) },
}))

const { updateSettings } = await import('@main/ipc/domains/settings/handlers')

function settingsWith(enabled: boolean, currentProviderId = 'p1'): AppSettings {
  return {
    defaultBackend: 'codex',
    backendPaths: { codex: null, claude: null },
    defaultRuntimeConfig: { codex: {}, claude: {} },
    protocolBridge: {
      enabled,
      currentProviderId,
      providers: {
        p1: {
          id: 'p1',
          name: 't',
          presetId: 'custom',
          createdAt: 1,
          protocol: 'anthropic.messages',
          baseUrl: 'https://x',
          modelsUrl: '',
          model: null,
          credentialSource: 'stored',
          credentialEnvVar: '',
          capabilities: {
            supportsImages: true,
            dropSamplingWhenThinking: true,
            defaultMaxOutputTokens: 8192,
            toolNameMaxLength: 64,
          },
          modelListMode: 'manual',
          manualModels: [],
        },
      },
    },
    defaultEditor: 'vscode',
    theme: {},
    httpProxy: {},
    language: 'zh-CN',
    sendOnEnter: true,
    showReasoningByDefault: false,
  } as unknown as AppSettings
}

describe('updateSettings 重连条件', () => {
  beforeEach(() => {
    mocks.applySettings.mockClear()
    mocks.reconnectBackend.mockClear()
    mocks.getCurrentId.mockReturnValue('codex')
  })

  test('桥开关翻转（关→开）且当前是 codex → 重连', async () => {
    mocks.load.mockReturnValue(settingsWith(false))
    mocks.update.mockReturnValue(settingsWith(true))
    await updateSettings({ patch: {} })
    expect(mocks.reconnectBackend).toHaveBeenCalledWith('codex')
  })

  test('桥开关翻转（开→关）且当前是 codex → 重连', async () => {
    mocks.load.mockReturnValue(settingsWith(true))
    mocks.update.mockReturnValue(settingsWith(false))
    await updateSettings({ patch: {} })
    expect(mocks.reconnectBackend).toHaveBeenCalledWith('codex')
  })

  test('纯切 provider（enabled 不变）→ 不重连', async () => {
    mocks.load.mockReturnValue(settingsWith(true, 'p1'))
    mocks.update.mockReturnValue(settingsWith(true, 'p2'))
    await updateSettings({ patch: {} })
    expect(mocks.reconnectBackend).not.toHaveBeenCalled()
  })

  test('enabled 不变且改了 provider 字段 → 不重连', async () => {
    mocks.load.mockReturnValue(settingsWith(true, 'p1'))
    mocks.update.mockReturnValue(settingsWith(true, 'p1'))
    await updateSettings({ patch: {} })
    expect(mocks.reconnectBackend).not.toHaveBeenCalled()
  })

  test('开关翻转但当前不是 codex → 不重连', async () => {
    mocks.getCurrentId.mockReturnValue('claude')
    mocks.load.mockReturnValue(settingsWith(false))
    mocks.update.mockReturnValue(settingsWith(true))
    await updateSettings({ patch: {} })
    expect(mocks.reconnectBackend).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试确认通过**

Run: `pnpm rebuild:node && npx vitest run tests/ipc/settings-bridge-reconnect.test.ts`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add tests/ipc/settings-bridge-reconnect.test.ts
git commit -m "test(bridge): 验证 updateSettings 只在桥开关翻转时重连 codex"
```

---

## Task 13: 重写 ProtocolBridgeSection.vue — 列表 + 编辑区两层（renderer）

这是最大的单文件改动。分步进行，每步保持可编译。

**Files:**
- Modify: `src/renderer/src/components/settings/ProtocolBridgeSection.vue`

- [ ] **Step 1: 重写 script setup —— 数据源与状态**

整块替换 `<script setup lang="ts">` 内容。新逻辑：editing/current 拆开；provider 列表按 createdAt 排序；增删改函数。

```ts
import { Button } from '@renderer/components/ui/button'
import { DropdownMenu, type DropdownOption } from '@renderer/components/ui/dropdown-menu'
import { Input } from '@renderer/components/ui/input'
import { useBackendStore } from '@renderer/stores/backend'
import { useSettingsStore } from '@renderer/stores/settings'
import type { ModelOption } from '@shared/backend/types'
import {
  BRIDGE_UPSTREAM_PRESETS,
  bridgeUpstreamPreset,
  createProviderFromPreset,
  type BridgeProvider,
  type BridgeStatus,
} from '@shared/protocol/bridge-config'
import type { ProtocolBridgeSettings } from '@shared/settings-schema'
import { computed, onMounted, ref, watch } from 'vue'

const settings = useSettingsStore()
const backendStore = useBackendStore()

const status = ref<BridgeStatus | null>(null)
const secretDraft = ref('')
const testing = ref(false)
const testResult = ref<{ ok: boolean; message: string } | null>(null)
const upstreamModels = ref<ModelOption[]>([])
const loadingModels = ref(false)
const modelsError = ref<string | null>(null)
/** 当前在编辑区显示哪个 provider（和 currentProviderId 独立） */
const editingProviderId = ref<string | null>(null)
/** 编辑中 provider 的凭证是否已就绪（编辑非当前 provider 时用） */
const editingCredentialReady = ref(false)

const bridge = computed<ProtocolBridgeSettings>(
  () => settings.settings?.protocolBridge ?? { enabled: false, currentProviderId: '', providers: {} },
)
const enabled = computed(() => bridge.value.enabled)
/** 按 createdAt 升序的 provider 列表 */
const providerList = computed<BridgeProvider[]>(() =>
  Object.values(bridge.value.providers).sort((a, b) => a.createdAt - b.createdAt),
)
const currentProvider = computed<BridgeProvider | null>(
  () => bridge.value.providers[bridge.value.currentProviderId] ?? null,
)
const editingProvider = computed<BridgeProvider | null>(
  () => (editingProviderId.value ? bridge.value.providers[editingProviderId.value] ?? null : null),
)

const presetOptions = computed<DropdownOption<string>[]>(() =>
  BRIDGE_UPSTREAM_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
)

const credentialSources: Array<{ value: BridgeProvider['credentialSource']; label: string }> = [
  { value: 'stored', label: '直接保存在 catmax' },
  { value: 'env', label: '读环境变量' },
]

const modelListModes: Array<{ value: BridgeProvider['modelListMode']; label: string }> = [
  { value: 'auto', label: '自动获取' },
  { value: 'manual', label: '手动录入' },
]

function checked(event: Event): boolean {
  return (event.target as HTMLInputElement).checked
}

// —— settings patch 主路 ——
async function patchBridge(patch: Partial<ProtocolBridgeSettings>): Promise<void> {
  await settings.update({ protocolBridge: { ...bridge.value, ...patch } })
  await refreshStatus()
}

/** 改某个 provider 的字段，不动 currentProviderId */
async function patchProvider(providerId: string, patch: Partial<BridgeProvider>): Promise<void> {
  const p = bridge.value.providers[providerId]
  if (!p) return
  await patchBridge({
    providers: { ...bridge.value.providers, [providerId]: { ...p, ...patch } },
  })
}

// —— 列表操作 ——
async function switchProvider(id: string): Promise<void> {
  await patchBridge({ currentProviderId: id })
  await refreshModels()
}

function selectEditing(id: string): void {
  editingProviderId.value = id
  secretDraft.value = ''
  testResult.value = null
  void refreshEditingCredentialReady()
}

async function addProvider(presetId: string): Promise<void> {
  const provider = createProviderFromPreset(presetId)
  await patchBridge({
    providers: { ...bridge.value.providers, [provider.id]: provider },
    currentProviderId: provider.id,
  })
  editingProviderId.value = provider.id
  await refreshModels()
}

async function deleteProvider(id: string): Promise<void> {
  // 先清该 provider 的凭证，再删数据
  await window.api.backend.setBridgeCredential({ providerId: id, secret: '' })
  const nextProviders = { ...bridge.value.providers }
  delete nextProviders[id]
  // 修正 currentProviderId：删的是当前就指向第一个（按 createdAt），否则不动
  let nextCurrent = bridge.value.currentProviderId
  if (nextCurrent === id) {
    const remaining = Object.values(nextProviders).sort((a, b) => a.createdAt - b.createdAt)
    nextCurrent = remaining[0]?.id ?? ''
  }
  await patchBridge({ providers: nextProviders, currentProviderId: nextCurrent })
  if (editingProviderId.value === id) editingProviderId.value = nextCurrent || null
}

// —— 状态刷新 ——
async function refreshStatus(): Promise<void> {
  status.value = await window.api.backend.bridgeStatus()
}

async function refreshEditingCredentialReady(): Promise<void> {
  if (!editingProviderId.value) {
    editingCredentialReady.value = false
    return
  }
  editingCredentialReady.value = await window.api.backend.bridgeCredentialReady({
    providerId: editingProviderId.value,
  })
}

async function refreshModels(): Promise<void> {
  loadingModels.value = true
  modelsError.value = null
  try {
    await backendStore.refreshModelsFor('codex')
    upstreamModels.value = backendStore.modelsByBackend.codex ?? []
    if (upstreamModels.value.length === 0 && enabled.value) {
      modelsError.value = '没有拉到模型，检查地址和 API key'
    }
  } catch (e) {
    upstreamModels.value = []
    modelsError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loadingModels.value = false
  }
}

// —— 凭证（按 editing provider）——
async function saveSecret(): Promise<void> {
  if (!editingProviderId.value) return
  status.value = await window.api.backend.setBridgeCredential({
    providerId: editingProviderId.value,
    secret: secretDraft.value,
  })
  secretDraft.value = ''
  testResult.value = null
  await refreshEditingCredentialReady()
  await refreshModels()
}

async function clearSecret(): Promise<void> {
  if (!editingProviderId.value) return
  status.value = await window.api.backend.setBridgeCredential({
    providerId: editingProviderId.value,
    secret: '',
  })
  secretDraft.value = ''
  testResult.value = null
  await refreshEditingCredentialReady()
}

async function testUpstream(): Promise<void> {
  if (!editingProviderId.value) return
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await window.api.backend.testBridgeUpstream({
      providerId: editingProviderId.value,
    })
  } catch (e) {
    testResult.value = { ok: false, message: e instanceof Error ? e.message : String(e) }
  } finally {
    testing.value = false
  }
}

// —— 手填模型维护 ——
const manualModelDraft = ref('')
async function addManualModel(): Promise<void> {
  if (!editingProvider.value) return
  const id = manualModelDraft.value.trim()
  if (!id || editingProvider.value.manualModels.includes(id)) {
    manualModelDraft.value = ''
    return
  }
  await patchProvider(editingProvider.value.id, {
    manualModels: [...editingProvider.value.manualModels, id],
  })
  manualModelDraft.value = ''
}
async function removeManualModel(id: string): Promise<void> {
  if (!editingProvider.value) return
  await patchProvider(editingProvider.value.id, {
    manualModels: editingProvider.value.manualModels.filter((m) => m !== id),
  })
}

async function toggleEnabled(): Promise<void> {
  await patchBridge({ enabled: !enabled.value })
  await refreshModels()
}

// 当前激活 provider 变化时，编辑区默认跟随显示它（首次加载/无编辑选中时）
watch(
  currentProvider,
  (cur) => {
    if (cur && !editingProviderId.value) editingProviderId.value = cur.id
  },
  { immediate: true },
)

onMounted(async () => {
  await refreshStatus()
  if (enabled.value) await refreshModels()
  await refreshEditingCredentialReady()
})
```

- [ ] **Step 2: 重写 template —— 列表层 + 编辑区**

整块替换 `<template>` 内容：

```vue
<template>
  <!-- Protocol Bridge: codex 只会说 Responses 协议，这一节让它能接 Anthropic 等其它协议的上游 -->
  <section class="flex flex-col gap-3">
    <header class="flex items-start justify-between gap-4">
      <div>
        <h2 class="text-lg font-semibold text-foreground">协议转换桥</h2>
        <p class="text-sm text-muted-foreground">
          codex 从 0.96 起只支持 Responses 协议。开启后 catmax 在本机起一个只听 127.0.0.1
          的转换服务，对 codex 装成 Responses 端点，对上游说上游的协议。可保存多个上游配置，同时只启用一个。
        </p>
      </div>
      <div class="mt-1 flex shrink-0 items-center gap-2">
        <span :class="['text-xs font-medium', enabled ? 'text-success' : 'text-muted-foreground']">
          {{ enabled ? '已开启' : '已关闭' }}
        </span>
        <button
          type="button"
          role="switch"
          :aria-checked="enabled"
          aria-label="启用协议转换桥"
          :class="[
            'relative w-11 h-6 rounded-full border-2 shadow-sm transition-colors cursor-pointer',
            enabled ? 'border-success bg-success' : 'border-foreground/60 bg-muted',
          ]"
          @click="toggleEnabled"
        >
          <span
            :class="[
              'absolute top-0.5 left-0.5 w-4 h-4 rounded-full shadow-md transition-transform',
              enabled ? 'translate-x-5 bg-primary-foreground' : 'bg-foreground',
            ]"
          />
        </button>
      </div>
    </header>

    <!-- 运行状态（仅 enabled 显示） -->
    <div v-if="enabled" class="flex items-center gap-2 text-xs px-3 py-2 rounded-md bg-muted/30">
      <span
        :class="['w-1.5 h-1.5 rounded-full', status?.running ? 'bg-success' : 'bg-destructive']"
      />
      <span class="text-muted-foreground">
        {{ status?.running ? `桥已监听 ${status.baseUrl}` : '桥未运行' }}
      </span>
      <span v-if="!currentProvider" class="text-destructive">未选择上游配置</span>
      <span v-if="status?.lastError" class="text-destructive ml-auto">{{ status.lastError }}</span>
    </div>

    <!-- Provider 列表（始终可见） -->
    <div class="flex flex-col gap-1.5">
      <label class="text-xs text-muted-foreground">上游配置</label>
      <div class="flex flex-col gap-1">
        <div
          v-for="p in providerList"
          :key="p.id"
          :class="[
            'flex items-center gap-2 px-3 py-2 rounded-md border text-sm cursor-pointer transition-colors',
            p.id === bridge.currentProviderId
              ? 'border-foreground bg-muted/40'
              : 'border-sidebar-border hover:bg-muted/20',
          ]"
          @click="selectEditing(p.id)"
        >
          <input
            type="radio"
            :checked="p.id === bridge.currentProviderId"
            class="cursor-pointer"
            @click.stop="switchProvider(p.id)"
          />
          <span class="flex-1 truncate">{{ p.name || p.baseUrl || '(未命名)' }}</span>
          <span v-if="p.id === bridge.currentProviderId" class="text-xs text-success">当前</span>
          <span v-if="p.modelListMode === 'manual'" class="text-xs text-muted-foreground">手动</span>
          <button
            type="button"
            class="text-xs text-muted-foreground hover:text-foreground px-1"
            title="编辑"
            @click.stop="selectEditing(p.id)"
          >
            ✎
          </button>
          <button
            type="button"
            class="text-xs text-muted-foreground hover:text-destructive px-1"
            title="删除"
            @click.stop="deleteProvider(p.id)"
          >
            🗑
          </button>
        </div>
      </div>
      <DropdownMenu
        :model-value="''"
        :options="presetOptions"
        placeholder="+ 新建配置"
        @update:model-value="(v) => addProvider(String(v))"
      />
    </div>

    <!-- 编辑区（选中 provider 时显示） -->
    <template v-if="editingProvider">
      <div class="h-px bg-sidebar-border" />

      <!-- 名称 -->
      <div class="flex flex-col gap-1.5">
        <label class="text-xs text-muted-foreground">名称</label>
        <Input
          :model-value="editingProvider.name"
          placeholder="我的 DeepSeek"
          @update:model-value="(v: string | number) => patchProvider(editingProvider!.id, { name: String(v) })"
        />
      </div>

      <!-- 上游地址 -->
      <div class="flex flex-col gap-1.5">
        <label class="text-xs text-muted-foreground">上游地址（base URL）</label>
        <Input
          :model-value="editingProvider.baseUrl"
          placeholder="https://api.deepseek.com/anthropic"
          @update:model-value="(v: string | number) => patchProvider(editingProvider!.id, { baseUrl: String(v) })"
        />
      </div>

      <!-- 兜底模型名 -->
      <div class="flex flex-col gap-1.5">
        <label class="text-xs text-muted-foreground">兜底模型名</label>
        <Input
          :model-value="editingProvider.model ?? ''"
          placeholder="deepseek-v4-pro"
          @update:model-value="
            (v: string | number) => patchProvider(editingProvider!.id, { model: String(v) || null })
          "
        />
        <p class="text-xs text-muted-foreground">
          codex 发来的模型名不在上游列表里时用它顶上。
        </p>
      </div>

      <!-- 模型列表来源 -->
      <div class="flex flex-col gap-2">
        <label class="text-xs text-muted-foreground">模型列表来源</label>
        <div class="flex gap-2">
          <button
            v-for="option in modelListModes"
            :key="option.value"
            type="button"
            :class="[
              'px-3 py-1.5 rounded-md border text-xs transition-colors cursor-pointer',
              editingProvider.modelListMode === option.value
                ? 'border-foreground bg-foreground text-background shadow-sm'
                : 'border-sidebar-border text-muted-foreground hover:text-foreground',
            ]"
            @click="patchProvider(editingProvider!.id, { modelListMode: option.value })"
          >
            {{ option.label }}
          </button>
        </div>

        <!-- auto: modelsUrl + 拉取按钮 -->
        <template v-if="editingProvider.modelListMode === 'auto'">
          <details class="text-xs">
            <summary class="cursor-pointer text-muted-foreground hover:text-foreground">
              模型列表地址（留空自动推断）
            </summary>
            <div class="mt-2 pl-3 border-l border-sidebar-border flex flex-col gap-1.5">
              <Input
                :model-value="editingProvider.modelsUrl"
                placeholder="https://api.deepseek.com/models"
                @update:model-value="
                  (v: string | number) => patchProvider(editingProvider!.id, { modelsUrl: String(v) })
                "
              />
            </div>
          </details>
          <div class="flex items-center gap-2">
            <Button variant="ghost" size="sm" :disabled="loadingModels" @click="refreshModels">
              {{ loadingModels ? '拉取中…' : '拉取上游模型列表' }}
            </Button>
          </div>
          <div v-if="upstreamModels.length > 0" class="flex flex-wrap gap-1.5">
            <button
              v-for="model in upstreamModels"
              :key="model.id"
              type="button"
              :class="[
                'px-2 py-0.5 rounded border text-xs transition-colors cursor-pointer',
                editingProvider.model === model.id
                  ? 'border-foreground bg-foreground text-background shadow-sm'
                  : 'border-sidebar-border text-muted-foreground hover:text-foreground',
              ]"
              @click="patchProvider(editingProvider!.id, { model: model.id })"
            >
              {{ model.id }}
            </button>
          </div>
          <p v-else-if="modelsError" class="text-xs text-destructive">{{ modelsError }}</p>
        </template>

        <!-- manual: 手填列表 -->
        <template v-else>
          <div class="flex items-center gap-2">
            <Input
              v-model="manualModelDraft"
              placeholder="输入模型名，回车添加"
              class="flex-1"
              @keydown.enter.prevent="addManualModel"
            />
            <Button variant="outline" size="sm" :disabled="!manualModelDraft.trim()" @click="addManualModel">
              添加
            </Button>
          </div>
          <div v-if="editingProvider.manualModels.length > 0" class="flex flex-wrap gap-1.5">
            <button
              v-for="id in editingProvider.manualModels"
              :key="id"
              type="button"
              :class="[
                'px-2 py-0.5 rounded border text-xs transition-colors cursor-pointer',
                editingProvider.model === id
                  ? 'border-foreground bg-foreground text-background shadow-sm'
                  : 'border-sidebar-border text-muted-foreground hover:text-foreground',
              ]"
              @click="patchProvider(editingProvider!.id, { model: id })"
            >
              {{ id }} <span class="ml-1 opacity-60" @click.stop="removeManualModel(id)">×</span>
            </button>
          </div>
          <p class="text-xs text-muted-foreground">
            手动录入的模型会显示在 codex 下拉框里，codex 选用时原样透传给上游。
          </p>
        </template>
      </div>

      <!-- 凭证 -->
      <div class="flex flex-col gap-2">
        <label class="text-xs text-muted-foreground">API key 来源</label>
        <div class="flex gap-2">
          <button
            v-for="option in credentialSources"
            :key="option.value"
            type="button"
            :class="[
              'px-3 py-1.5 rounded-md border text-xs transition-colors cursor-pointer',
              editingProvider.credentialSource === option.value
                ? 'border-foreground bg-foreground text-background shadow-sm'
                : 'border-sidebar-border text-muted-foreground hover:text-foreground',
            ]"
            @click="patchProvider(editingProvider!.id, { credentialSource: option.value })"
          >
            {{ option.label }}
          </button>
        </div>
        <template v-if="editingProvider.credentialSource === 'env'">
          <Input
            :model-value="editingProvider.credentialEnvVar"
            placeholder="DEEPSEEK_API_KEY"
            @update:model-value="
              (v: string | number) => patchProvider(editingProvider!.id, { credentialEnvVar: String(v) })
            "
          />
          <p class="text-xs text-muted-foreground">
            catmax 只记住变量名，值在每次请求时从进程环境读取——不落盘。
          </p>
        </template>
        <template v-else>
          <div class="flex items-center gap-2">
            <Input
              v-model="secretDraft"
              type="password"
              :placeholder="
                editingCredentialReady ? '已保存（重新输入可覆盖）' : '粘贴上游 API key'
              "
              class="flex-1"
            />
            <Button variant="outline" size="sm" :disabled="!secretDraft" @click="saveSecret">
              保存
            </Button>
            <Button
              variant="outline"
              size="sm"
              :disabled="!editingCredentialReady"
              @click="clearSecret"
            >
              清除
            </Button>
          </div>
          <p class="text-xs text-muted-foreground">
            存在 catmax 数据目录下权限 0600 的单独文件里（不进 settings.json），界面不会再回显。
          </p>
        </template>
      </div>

      <!-- 连通性自检 -->
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" :disabled="testing" @click="testUpstream">
          {{ testing ? '测试中…' : '测试上游连通性' }}
        </Button>
        <span
          v-if="testResult"
          :class="['text-xs', testResult.ok ? 'text-success' : 'text-destructive']"
        >
          {{ testResult.message }}
        </span>
      </div>

      <!-- 上游能力 -->
      <details class="text-xs">
        <summary class="cursor-pointer text-muted-foreground hover:text-foreground">
          上游能力（影响转换时的降级策略）
        </summary>
        <div class="flex flex-col gap-2 mt-2 pl-3 border-l border-sidebar-border">
          <label class="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              :checked="editingProvider.capabilities.supportsImages"
              @change="patchProvider(editingProvider!.id, { capabilities: { ...editingProvider!.capabilities, supportsImages: checked($event) } })"
            />
            <span>支持图片输入</span>
          </label>
          <div class="flex items-center gap-2">
            <span>max_tokens 兜底值</span>
            <Input
              :model-value="editingProvider.capabilities.defaultMaxOutputTokens"
              type="number"
              class="w-28"
              @update:model-value="
                (v: string | number) =>
                  patchProvider(editingProvider!.id, {
                    capabilities: {
                      ...editingProvider!.capabilities,
                      defaultMaxOutputTokens: Number(v) || 8192,
                    },
                  })
              "
            />
          </div>
        </div>
      </details>
    </template>
  </section>
</template>
```

- [ ] **Step 3: typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 全通过。若有 lint 报错（如未用变量），按提示修。

- [ ] **Step 4: 跑全量测试确认无回归**

Run: `pnpm rebuild:node && pnpm test`
Expected: 所有测试通过（含 Task 3/5/10/11/12 新增测试）。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/settings/ProtocolBridgeSection.vue
git commit -m "feat(bridge): UI 改为 provider 列表 + 编辑区两层，支持手动模型列表录入"
```

---

## Task 14: 全量验收 + 手动冒烟

**Files:** 无（验证步骤）

- [ ] **Step 1: typecheck + lint + test 全过**

Run: `pnpm typecheck && pnpm lint && pnpm rebuild:node && pnpm test`
Expected: 全绿。

- [ ] **Step 2: 启动 dev 手动冒烟（按 spec 第 5.3 节脚本）**

Run: `pnpm dev`

逐项验证（见 spec 5.3）：
1. 全新 userData → 开桥 → 列表空 → 「新建 DeepSeek」→ 自动选中 + 编辑区出现预设值 → 填 key → 保存 → credentialReady=true。
2. 新建 Anthropic → 切换 radio → codex 不重连但模型列表刷新。
3. 删除当前 DeepSeek → currentProviderId 落到 Anthropic → 凭证文件里 DeepSeek key 被清。
4. 关桥 → 列表仍可见能编辑 → 开桥 → 仍指向前一个 currentProviderId。
5. 新建智谱编程套餐 → baseUrl 正确、模型来源默认 manual、手填含 glm-5.2/glm-5-turbo/glm-4.7 → codex 下拉框显示这三个（不联网）。
6. 智谱配置上手填新增 glm-4.6v → 下拉框立即出现。
7. auto↔manual 切换 UI 正确响应。

- [ ] **Step 3: 最终 Commit（若有冒烟中发现的小修）**

```bash
git add -A
git commit -m "chore(bridge): 多上游配置手动验收通过"
```

---

## 自审记录（writing-plans self-review）

执行完上述任务后，对照 spec 检查覆盖度：

- [x] **Spec 第 1 部分（数据模型）** → Task 1/2/4 全覆盖（schema + 类型 + 工厂 + 智谱预设）。
- [x] **Spec 第 2 部分（凭证）** → Task 6（Step 5 resolveCredential）+ Task 8（IPC 加 providerId）+ Task 11（凭证独立测试）。存储层零改动已确认（Task 11 测试验证）。
- [x] **Spec 第 3 部分（运行时）** → Task 6 全覆盖（currentProvider/applySettings/resolve*/listUpstreamModels auto-manual 分叉/identity 比较）+ Task 7（builtin-plugins 兜底模型引用）+ Task 9（重连条件）。
- [x] **Spec 第 4 部分（UI）** → Task 13 全覆盖（列表+编辑区两层、editing/current 拆分、模型来源控件、手填区、凭证 per-provider）。
- [x] **Spec 第 5 部分（测试）** → Task 3/5/10/11/12 全部 6 类测试。
- [x] **手动验收** → Task 14。

**类型一致性检查**：`BridgeProvider`/`BridgeSettings`/`BridgeModelListMode` 在所有任务中名称统一；`currentProvider()`/`createProviderFromPreset`/`patchProvider`/`switchProvider`/`addProvider`/`deleteProvider` 命名前后一致；IPC channel `BACKEND_BRIDGE_CREDENTIAL_READY` 与 contract/handler/preload 三处一致。
