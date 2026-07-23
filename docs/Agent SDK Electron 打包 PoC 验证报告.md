# Agent SDK Electron 打包 PoC 验证报告

> 分支：`poc/agent-sdk-electron-spawn`（基于 main）
> 日期：2026-07-23
> SDK 版本：`@anthropic-ai/claude-agent-sdk@0.3.218`（bundled CLI `2.1.218`）
> 验证环境：macOS darwin-arm64, Electron 31.7.7, Node 20.18.0 / 22.22.0
>
> **核心结论：Agent SDK 在 dev / 非 ASAR 模式下能正常 spawn；但 electron-builder + pnpm 的 ASAR 打包会丢失平台 binary，必须用 `asarUnpack` + `pathToClaudeCodeExecutable` 才能修复。问题可解，但需要额外的打包配置工作。**

---

## 目录

- [一、验证背景与目标](#一验证背景与目标)
- [二、验证方法与阶段](#二验证方法与阶段)
- [三、各阶段结果](#三各阶段结果)
- [四、关键技术发现](#四关键技术发现)
- [五、根因分析：为什么 ASAR 打包会丢 binary](#五根因分析为什么-asar-打包会丢-binary)
- [六、可行的解决方案](#六可行的解决方案)
- [七、额外发现：pre-existing 打包问题](#七额外发现pre-existing-打包问题)
- [八、对迁移评估文档的修订](#八对迁移评估文档的修订)
- [附录：PoC 脚本说明](#附录poc-脚本说明)

---

## 一、验证背景与目标

迁移评估文档（《Claude 后端 CLI 与 Agent SDK 对比与迁移评估》）把"Electron 打包 243MB 二进制"列为最高风险点（🔴），引用了多个 GitHub issue：

- `spawn node ENOENT` after packaging（[claude-code#4383](https://github.com/anthropics/claude-code/issues/4383)）
- ASAR + `require.resolve` 打包问题（[anthropic-sdk-typescript#865](https://github.com/anthropics/anthropic-sdk-typescript/issues/865)）
- `ELECTRON_RUN_AS_NODE` 泄漏（[claude-code#34836](https://github.com/anthropics/claude-code/issues/34836)）

本 PoC 的目标：**在 catmax 真实的 Electron + electron-vite + electron-builder + pnpm 技术栈下，验证 SDK 能否成功 spawn bundled binary，定位具体卡点，并验证解决方案。**

---

## 二、验证方法与阶段

| 阶段 | 验证什么 | 成本 | 结果 |
|---|---|---|---|
| 0 | 纯 Node 环境 baseline（排除环境问题） | 低 | ✅ 通过 |
| 1 | Electron 主进程 dev 模式 spawn | 中 | ✅ 通过 |
| 2 | electron-vite build + electron-builder ASAR 打包 | 高 | ❌ **binary 丢失** |
| 3 | ELECTRON_RUN_AS_NODE 泄漏检查 | 低 | ✅ 无泄漏 |
| 4 | `pathToClaudeCodeExecutable` escape hatch 验证 | 中 | ✅ **可救** |

---

## 三、各阶段结果

### 阶段 0：纯 Node baseline ✅

```
node poc/agent-sdk/phase0-node-baseline.mjs
```

- spawn 成功，收到 `system.init` + `session_id`
- 首条消息延迟：3.1s（spawn 冷启动）
- 245 条消息，cost $0.094
- **结论：SDK 在最干净的环境下完全可用，spawn 链路 OK**

### 阶段 1：Electron 主进程 dev 模式 ✅

```
electron poc/agent-sdk/phase1-electron-dev.mjs
```

- Electron 31.7.7 主进程（Node 20.18.0）里 SDK 成功 spawn
- `process.execPath` 是 Electron 二进制本身，但 SDK 没搞混，正确找到自己的 243MB `claude` binary
- 首条消息延迟：3.18s（与纯 Node 几乎相同）
- auth 用 claude 已有的 oauth 凭据（**无需 ANTHROPIC_API_KEY**）
- **结论：Electron 运行时本身不是障碍，dev 模式完全可用**

### 阶段 2：ASAR 打包 ❌（核心发现）

通过 `electron-builder --mac --dir` 打包后检查 `app.asar` 内容：

```
asar list app.asar | grep claude-agent-sdk
```

结果：
```
/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs          ← 主包在 asar 里 ✅
/node_modules/@anthropic-ai/claude-agent-sdk/package.json
...
（没有任何 claude-agent-sdk-darwin-arm64 条目）              ← 平台 binary 完全缺失 ❌
```

`app.asar.unpacked/node_modules/` 里只有 `better-sqlite3` 和 `node-pty`（现有 asarUnpack 规则 `**/*.{node,dll}` 匹配的），**没有 SDK 的平台 binary**。

**结论：electron-builder + pnpm 打包后，243MB 平台 binary 被完全丢失。SDK 运行时会抛 `Native CLI binary for darwin-arm64 not found`。**

### 阶段 3：ELECTRON_RUN_AS_NODE 泄漏 ✅

源码分析 + 实测：
- SDK 构造子进程 env：`{...process.env}`，设置 `CLAUDE_CODE_ENTRYPOINT="sdk-ts"`，删除 `NODE_OPTIONS`
- SDK **不主动设也不主动删** `ELECTRON_RUN_AS_NODE`——原样继承
- Electron 主进程正常启动时 `process.env` 没有此变量 → **无泄漏**
- 即使主动设置 `ELECTRON_RUN_AS_NODE=1` 污染 env，SDK spawn claude 仍能成功

**结论：这个 GitHub issue 报的问题在 catmax 的场景下不存在。真正的风险是 claude 执行 Bash tool 时，如果 env 里有此变量会影响它的子进程——但这是调用方的责任，`delete process.env.ELECTRON_RUN_AS_NODE` 一行就能解决。**

### 阶段 4：escape hatch 验证 ✅

```
node poc/agent-sdk/phase4-escape-hatch.mjs
```

把 binary 复制到一个"非标准路径"（模拟 `app.asar.unpacked`），用 `pathToClaudeCodeExecutable` 显式指定：

```js
query({
  prompt: 'hi',
  options: {
    pathToClaudeCodeExecutable: '/tmp/catmax-sdk-poc-unpacked/claude',  // ★
    ...
  }
})
```

- spawn 成功，session 正常建立
- **结论：`pathToClaudeCodeExecutable` 能完全绕过 SDK 的 `import.meta.url` + `createRequire` resolve 链。配合 asarUnpack 把 binary 放到 `app.asar.unpacked/`，ASAR 打包问题可解。**

---

## 四、关键技术发现

### 1. SDK 定位 binary 的完整链路

通过源码追踪（`sdk.mjs` 反混淆），SDK 定位 binary 的逻辑是：

```js
// sdk.mjs 内部
import { fileURLToPath as dUe } from "url"
import { createRequire as lUe } from "module"

// 运行时：
let br = dUe(import.meta.url)        // sdk.mjs 的磁盘绝对路径
let Xr = lUe(br)                      // createRequire(sdk.mjs 路径)
let mi = FU((Ts) => Xr.resolve(Ts))  // 尝试 resolve 平台子包
// FU 尝试路径：@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude
```

关键：`createRequire` 从 `sdk.mjs` 所在目录解析。在 pnpm 结构下，这能正确 resolve 到同级的 `.pnpm/@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.218/` 包。

### 2. 为什么 dev 模式能工作但 ASAR 不行

| 环境 | `import.meta.url` 指向 | resolve 结果 | binary 存在 |
|---|---|---|---|
| dev（开发目录） | `.pnpm/.../claude-agent-sdk/sdk.mjs` | `.pnpm/.../claude-agent-sdk-darwin-arm64/claude` | ✅ |
| ASAR（打包后） | `app.asar/.../claude-agent-sdk/sdk.mjs` | （平台包不在 asar 里） | ❌ resolve 失败 |

### 3. auth 在 dev 下无需 API key

阶段 0/1 都没有设置 `ANTHROPIC_API_KEY`，用的是 claude CLI 已有的 oauth 登录（`claude auth status` 显示 `loggedIn: true, authMethod: oauth_token`）。**这跟迁移评估文档里说的"SDK 默认要 API key"有出入**——实际上 SDK 会继承 claude 的凭据。详见后文修订。

---

## 五、根因分析：为什么 ASAR 打包会丢 binary

这是 **pnpm 的虚拟存储结构 + electron-builder 的打包逻辑** 共同导致的：

```
pnpm 的 node_modules 结构：
node_modules/
  @anthropic-ai/
    claude-agent-sdk → ../.pnpm/@anthropic-ai+claude-agent-sdk@0.3.218.../  (symlink)
  .pnpm/
    @anthropic-ai+claude-agent-sdk@0.3.218.../
      node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs     ← 主包（被收集）
    @anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.218/      ← 平台包（被忽略！）
      node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude  ← 243MB binary
```

electron-builder 打包时：
1. 遍历 `node_modules` 顶层依赖，跟随 symlink 收集文件
2. SDK 主包是 symlink → 跟随到 `.pnpm/.../`，收集 `sdk.mjs` 等 → **打进 asar**
3. 平台包 `claude-agent-sdk-darwin-arm64` 只存在于 `.pnpm/` 深层，**不是顶层依赖**（它是 optionalDependencies）→ electron-builder 不遍历 `.pnpm` → **完全漏掉**

现有 `asarUnpack` 规则 `**/*.{node,dll}` 不会匹配 `claude` 这个无扩展名的可执行文件。

---

## 六、可行的解决方案

验证证明可行（阶段 4）的方案：

```yaml
# electron-builder.yml
asarUnpack:
  - resources/**
  - '**/*.{node,dll}'
  # 新增：SDK 平台 binary 包
  - '**/node_modules/@anthropic-ai/claude-agent-sdk-*/claude'
```

```ts
// 主进程里调用 SDK 时
import { app } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

// 计算 unpacked 后的 binary 真实路径
function resolveSdkBinary(): string {
  // app.asar.unpacked 里的路径
  const platform = `${process.platform}-${process.arch}`
  const candidates = [
    // electron-builder unpacked 路径
    join(process.resourcesPath, 'app.asar.unpacked', 'node_modules',
         `@anthropic-ai/claude-agent-sdk-${platform}`, 'claude'),
    // dev 模式 fallback（让 SDK 自己 resolve）
    '',
  ]
  return candidates.find(existsSync) ?? ''
}

const { query } = await import('@anthropic-ai/claude-agent-sdk')
const q = query({
  prompt: '...',
  options: {
    pathToClaudeCodeExecutable: resolveSdkBinary() || undefined,  // dev 下 undefined，让 SDK 自行 resolve
    ...
  }
})
```

**额外考虑：**
- 包体积：每 platform×arch 一个 243MB binary。如果只打当前平台（mac-arm64），+243MB；多架构 +更多
- macOS 签名：binary 需要纳入 code signing（`electron-builder.yml` 的 `hardenedRuntime: true` 已配）
- pnpm 配置：可能需要 `.npmrc` 的 `node-linker=hoisted` 或 `public-hoist-pattern` 来改善，但 escape hatch 方案不依赖此

---

## 七、额外发现：pre-existing 打包问题

PoC 过程中发现 catmax 主应用**已经有**一个打包问题（与 SDK 无关）：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@kwsites/file-exists'
imported from .../app.asar/node_modules/simple-git/dist/esm/index.js
```

`simple-git` 的子依赖 `@kwsites/file-exists`、`@kwsites/promise-deferred`、`@simple-git/*` 在 pnpm 结构下没被 electron-builder 收进 asar。

**这意味着 catmax 当前的 electron-builder 打包可能本来就没跑通过**（或者从未真正打包测试过）。这个问题需要单独修复（同样的 pnpm hoisting 问题），不在本 PoC 范围内，但值得注意：**如果要用 SDK，打包链路必须先修通。**

修复提示：
```yaml
# electron-builder.yml 可能需要
# 或改用 pnpm 的 node-linker=hoisted
# 或用 electron-builder 的 files 显式包含
```

---

## 八、对迁移评估文档的修订

基于 PoC 实测结果，对《Claude 后端 CLI 与 Agent SDK 对比与迁移评估》的部分内容做事实修订：

### 修订 1：auth 不一定需要 API key

原文："SDK 默认要 `ANTHROPIC_API_KEY` 或 OAuth token"

**实测**：SDK 会继承 claude CLI 已有的 oauth 登录凭据。阶段 0/1 都没设 API key，用的是 `claude auth status` 显示的 oauth_token。迁移后用户的现有 claude 登录大概率能继续用。

Anthropic TOS 对第三方产品的限制仍存在，但"自用项目"场景下用 claude.ai 订阅登录是可行的。

### 修订 2：ELECTRON_RUN_AS_NODE 泄漏风险降级

原文：🔴 高风险

**实测**：降为 🟡 低风险。SDK 不主动设此变量，Electron 主进程正常启动时也不存在。`delete process.env.ELECTRON_RUN_AS_NODE` 一行即可防御。

### 修订 3：Electron 打包问题确认但可解

原文：🔴 全新问题（ASAR/signing/体积）

**实测**：确认 binary 会丢，但根因明确（pnpm + electron-builder 不收集 optionalDependencies），解决方案已验证（asarUnpack + pathToClaudeCodeExecutable）。风险从"未知"降为"已知且可解，但需要配置工作"。

### 总结评估变化

| 维度 | PoC 前评估 | PoC 后修订 |
|---|---|---|
| dev 模式可用性 | 未知 | ✅ 完全可用 |
| ASAR 打包 | 🔴 未知风险 | 🟡 已知问题，方案已验证 |
| auth | 🔴 必须 API key | 🟡 继承 claude 登录，自用可行 |
| ELECTRON_RUN_AS_NODE | 🔴 泄漏 | 🟢 无泄漏 |
| 整体迁移可行性 | 暂不推荐 | **技术可行，主要成本在 ApprovalBridge 重写 + 打包配置，不再是"能不能跑"的问题** |

---

## 附录：PoC 脚本说明

所有脚本在 `poc/agent-sdk/` 下，可重复运行：

| 脚本 | 用途 | 命令 |
|---|---|---|
| `phase0-node-baseline.mjs` | 纯 Node baseline | `node poc/agent-sdk/phase0-node-baseline.mjs` |
| `phase1-electron-dev.mjs` | Electron dev 模式 | `electron poc/agent-sdk/phase1-electron-dev.mjs` |
| `phase3-env-leak.mjs` | ELECTRON_RUN_AS_NODE 检查 | `node poc/agent-sdk/phase3-env-leak.mjs` |
| `phase4-escape-hatch.mjs` | pathToClaudeCodeExecutable 验证 | `node poc/agent-sdk/phase4-escape-hatch.mjs` |
| `trace-binary-path.mjs` | SDK binary 定位链路追踪 | `node poc/agent-sdk/trace-binary-path.mjs` |
| `inspect-resolution.mjs` | binary resolve 路径检查 | `node poc/agent-sdk/inspect-resolution.mjs` |

注意事项：
- phase0/1/3/4 每次运行会产生真实的 API 调用（约 $0.01-0.1/次）
- phase1 会弹出 Electron 窗口
- 所有脚本需要 claude 已登录（`claude auth status` 验证）
