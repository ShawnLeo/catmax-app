# Claude 后端：CLI 子进程 vs Agent SDK 对比与迁移评估

> 适用范围：main 的 `ClaudeAdapter`（`src/main/backend/claude/adapter.ts`）及其周边
> 解决问题：任务运行中能否热切换 model / effort / permission；评估是否值得迁移到 Agent SDK
>
> **核心结论**：Agent SDK **并非 in-process 的 agent 循环**，它内部仍然 `child_process.spawn` 一个 bundled 的 `claude` 原生二进制（243MB，即 Claude Code CLI 本体）。SDK 的真正收益是（1）运行中热切 model/permission；（2）进程内权限回调 `canUseTool`，可干掉现有 ApprovalBridge/socket/MCP 那套复杂机制。代价是引入两个当前不存在的硬伤：**Electron 打包 243MB 二进制（ASAR/signing/体积）** 和 **强制 API key 认证（UX 退步 + 可能触 Anthropic TOS）**。当前结论：**暂不整体迁移**，先用低成本方案缓解痛点。

调研时间：2026-07。SDK 版本基线：`@anthropic-ai/claude-agent-sdk@0.3.218`（bundled CLI `2.1.218`）。

---

## 目录

- [一、背景：为什么有这个评估](#一背景为什么有这个评估)
- [二、Agent SDK 到底是什么（关键事实）](#二agent-sdk-到底是什么关键事实)
- [三、两种接入方式架构对比](#三两种接入方式架构对比)
- [四、热切换能力对比（核心诉求）](#四热切换能力对比核心诉求)
- [五、SDK 带来的真正收益](#五sdk-带来的真正收益)
- [六、迁移到 SDK 的具体问题](#六迁移到-sdk-的具体问题)
- [七、风险矩阵：现有耦合点 × 迁移代价](#七风险矩阵现有耦合点--迁移代价)
- [八、替代方案对比](#八替代方案对比)
- [九、结论与建议](#九结论与建议)
- [参考来源](#参考来源)

---

## 一、背景：为什么有这个评估

### 痛点

Claude 后端是**逐 turn 起子进程**的模式：每发一条消息，就 spawn 一个新的 `claude -p` 进程，把 `--model`/`--effort`/`--permission-mode` 作为命令行参数一次性钉死（`adapter.ts:306-396`）。进程跑起来后：

- **model / effort / permission 都无法中途修改** —— 它们是启动参数，不是运行时状态
- `startTurn` 把 prompt 写进 stdin 后立即 `endInput()` 关闭（`adapter.ts:412-413`），没有运行中下发指令的通道
- 接口里的 `steer`（中途插话）能力，Claude 声明 `supportsSteer: false`（`adapter.ts:109`），且未接 IPC

### 用户的真实场景

> 任务时间长，一开始忘了改 model/effort/permission，跑到一半想改。

评估 Agent SDK 是为了回答：**换接入方式能不能解锁真正的热切换，以及代价多大。**

---

## 二、Agent SDK 到底是什么（关键事实）

**Agent SDK 不是一个 in-process 的 agent 循环。它是一个 TypeScript/Python 包装层，内部仍然 spawn 一个 bundled 的 `claude` 原生二进制。**

### 四重验证（非推测）

1. **官方文档原话**：
   > *"Both the TypeScript and Python SDKs bundle a native Claude Code binary for your platform, so you don't need to install Claude Code separately."*
   — [overview](https://code.claude.com/docs/en/agent-sdk/overview)

2. **npm 元数据**：`@anthropic-ai/claude-agent-sdk@0.3.218` 有 8 个平台特定的 `optionalDependencies`：`@anthropic-ai/claude-agent-sdk-{linux,win32,darwin}-{x64,arm64}` + `linux-{x64,arm64}-musl`，每个都附带原生二进制。

3. **磁盘实测**：`node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` 是 243MB Mach-O 64-bit arm64 可执行文件。运行显示 `2.1.218 (Claude Code)` —— 就是 Claude Code CLI 本体。

4. **源码**：`sdk.mjs` 中 `import ... from "child_process"`，含 `spawnLocalProcess()`、`spawnClaudeCodeProcess()`、`spawn()` 调用。找不到平台二进制时会抛：
   > *"Native CLI binary for <platform> is missing. Specify a matching binary with options.pathToClaudeCodeExecutable."*

### 这个事实改变了一切

"迁移到 SDK = in-process 简化" 这个直觉是**错的**。底层还是 spawn 二进制，还是 stdio 通信，还是同一套 `~/.claude/projects/*.jsonl` 会话存储。SDK 的价值在于**包装层提供的编程 API**（typed events、运行时 setter、进程内回调），而不是消除 subprocess。

### 补充

- **曾用名**："Claude Code SDK"，2025 年 9 月左右改名 "Claude Agent SDK"。旧包 `@anthropic-ai/claude-code` / `claude-code-sdk` 已废弃。
- **成熟度**：仍为 0.x（pre-1.0），每周多次发布，跟踪 CLI v2.1.x。功能常被特定 CLI 版本 gate（如 mid-turn `setModel` 需 v2.1.212+）。
- **TypeScript V2**：官方曾尝试 V2 重写后回退，当前主线是 0.3.x。

---

## 三、两种接入方式架构对比

### 进程模型

```
当前 CLI 模式（catmax 在用）：每 turn 一个新进程

  turn 1:  spawn claude -p ...   →  输出  →  退出
  turn 2:  spawn claude -p --resume <id> ...  →  输出  →  退出
  turn 3:  spawn claude -p --resume <id> ...  →  输出  →  退出
           (每条消息冷启动一次；连续性靠 --resume + jsonl)


Agent SDK 模式：长存活进程 + 双向 JSON 流

  query({ prompt, options })  →  spawn bundled claude（一次）
     │                           ↑
     │  stdin: stream-json       │  SDK 在主进程内持有子进程
     │  (可继续发 user msg)      │
     ▼                           │
  for await (msg of query)       │  typed SDKMessage 流式回传
     ↑                           │
     │  control_request/response │  运行中可 setModel/setPermissionMode
     └───────────────────────────┘
```

### 维度对比

| 维度 | 当前 CLI 模式 | Agent SDK 模式 |
|---|---|---|
| **进程模型** | per-turn spawn，跑完即退 | SDK spawn 一次 bundled 二进制，可长存 |
| **通信协议** | 单向：stdin 写一次 prompt 就关闭；stdout 读 stream-json | 双向 JSON 流：`stream-json` 输出 + `control_request/control_response` 输入通道 |
| **会话连续性** | `--resume <id>`，每 turn 新进程 | 同进程内 `continue: true` / `resume: <id>`；读写**同样的** jsonl |
| **二进制依赖** | 用户自装的 `claude`（`opts.binaryPath`） | SDK 自带二进制，不需用户安装 |
| **功能覆盖** | CLI flag 子集 | **CLI 的超集**（所有 CLI 能力 + 编程 API） |
| **二进制大小** | 0（用系统的） | 每 platform×arch 一个 243MB 二进制 |
| **消息类型** | 手写 zod 解析 5 种 raw 消息 | typed `SDKMessage` 联合（与 stream-json 同构） |

---

## 四、热切换能力对比（核心诉求）

这是考虑迁移的唯一硬理由。下表来自官方 TS reference 文档原文。

| 配置项 | CLI 模式 | Agent SDK 模式 | SDK 来源 |
|---|---|---|---|
| **model** | ❌ spawn 时钉死 | ✅ **`Query.setModel()` 运行中切换**。官方：*"If you switch model while Claude is working on a turn, the response already generating finishes on the old model, the rest of the turn uses the new one."*（需 CLI v2.1.212+） | `setModel()` |
| **permissionMode** | ❌ spawn 时钉死 | ✅ **`Query.setPermissionMode()` 即时生效**：*"takes effect immediately for all subsequent tool requests"* | `setPermissionMode()` |
| **effort** | ❌ spawn 时钉死 | ⚠️ `applyFlagSettings({ effortLevel })` **下一 turn 生效**（非即时） | `applyFlagSettings()` |
| **steer（中途插话）** | ❌ `supportsSteer: false` | ✅ streaming-input 模式下可发新 user message | streaming-input |
| **逐次工具审批** | 靠 ApprovalBridge socket（复杂） | ✅ **`canUseTool` 进程内回调**（无需 MCP/socket） | `canUseTool` |

### `applyFlagSettings` 的生效时机（官方）

| 配置 key | 生效时机 |
|---|---|
| `model` | **当前 turn** 内生效（下一次 model 调用起） |
| `effortLevel` / `ultracode` / `permissions` / `hooks` / `skillOverrides` / `fastMode` / `agent` | **下一 turn** |
| system-prompt 相关选项 | **无运行时效果**（启动时一次性解析，必须新 session） |

**结论**：SDK 确实能解决 model/permission 的真热切换；effort 得等下一 turn（但下一 turn 在长进程模型里很快到来，不像 CLI 要重新 spawn）。

---

## 五、SDK 带来的真正收益

CLI 模式做不到、SDK 能做到的：

1. **运行中热切 model / permission**（核心收益，见上节）
2. **进程内权限回调 `canUseTool`** —— 直接干掉现有的 ApprovalBridge + Unix socket + 单独 MCP server 子进程 + `ELECTRON_RUN_AS_NODE` spawn + 临时 mcp-config JSON 那一整套（详见下节）。SDK 官方原话：*"canUseTool callback cannot be used with permissionPromptToolName. Please use one or the other."* —— 二者互斥，意味着用了 `canUseTool` 就不再需要 `--permission-prompt-tool`。
3. **长存活进程** —— 不再每条消息 spawn/退出，降低冷启动开销，适合 steer/多轮交互
4. **hooks 变进程内回调**（`PreToolUse`/`PostToolUse` 等 `HookCallback`），不用 shell 命令
5. **`createSdkMcpServer()`** —— MCP server 直接跑在主进程里，不 spawn
6. **typed events** —— `SDKMessage` 联合类型替代手写 zod 解析 stream-json 行

---

## 六、迁移到 SDK 的具体问题

把 catmax 当前对 CLI 的耦合点全摸了一遍，按"会不会炸"分类。

### 🔴 高风险 / 必须重做

#### 1. 整个 ApprovalBridge + catmax MCP server + socket 机制（最大重灾区）

现在的权限流是个三进程之舞：

```
adapter.ts:335-396  approval-bridge.ts  mcp/server.ts  mcp/protocol.ts
       │                 │                   │                │
       │  每 turn 建 Unix socket             │                │
       │  写临时 mcp-config JSON              │                │
       ▼                 ▼                   ▼                │
  --strict-mcp-config  claude spawn 一个 MCP server 子进程 ───┘
  --mcp-config <path>   (ELECTRON_RUN_AS_NODE 跑 Electron 二进制)
  --permission-prompt-tool mcp__catmax__approve
                          │
   权限请求：MCP tool → socket → bridge → adapter → IPC → UI
```

涉及文件：`approval-bridge.ts`、`mcp/server.ts`、`mcp/protocol.ts`、`electron.vite.config.ts:17-28`（`mcp-server` 构建入口）、`adapter.ts:335-396,606-697`。

**SDK 下这套全部多余**，换成注册一个 `canUseTool` 进程内回调即可。属于架构级重写，但改完之后会简单非常多——会更像现在 codex adapter 的 `registerApproval` 路径。渲染层的 `source === 'claude'` 路由（`message.ts:286-296`）和 `ClaudePermissionDialog.vue` 可以保留。

#### 2. 进程模型反转：per-turn spawn → 长存活进程

现在 claude 是 per-turn process（`adapter.ts:402-413`），codex 是长存活 JSON-RPC。SDK-based claude adapter 会更像 codex 形态：

- `ProcessSpawner` 不再用（SDK 自己 spawn bundled 二进制；但 codex 仍用，抽象可保留）
- interrupt 从 `ctx.proc.kill('SIGTERM')`（`adapter.ts:653`）变成 SDK 的 AbortController / interrupt API
- `TurnContext.proc` 字段消失
- stdin 写一次 + `endInput()` 的逻辑全部不要

#### 3. session_id 捕获的脆弱 dance

现在这套只因为 CLI 在运行时才铸造 session_id：

```
startSession: 占位 UUID
   ↓
首 turn: canResume=false → 不带 --resume → claude 铸造真实 session_id
   ↓
onChunk: 从 system.init 捕获 session_id  (adapter.ts:440-452)
   ↓
onRealSessionId → 写回 db.updateSessionBackendThreadId  (manager.ts:54-64)
   ↓
进程重启兜底: existsSync(jsonl) 判断占位 id 是否已变真实  (adapter.ts:286-302)
```

**SDK 的 resume API 应该能让这个 hack 消失**（直接传 `resume: <id>` 或从 query 结果拿回 id），但要重新设计会话状态机。

#### 4. Electron 打包（SDK 特有的全新坑，当前不存在）

Anthropic 自己的 issue 记录：

| 问题 | Issue |
|---|---|
| SDK 通过 `import.meta.url`/`require.resolve` 找二进制，在 ASAR 虚拟 FS 下 `spawn node ENOENT` | [claude-code#4383](https://github.com/anthropics/claude-code/issues/4383)、[anthropic-sdk-typescript#865](https://github.com/anthropics/anthropic-sdk-typescript/issues/865) |
| SDK 设的 `ELECTRON_RUN_AS_NODE=1` 泄漏进所有子进程，可能搞坏 Bash tool 子进程 | [claude-code#34836](https://github.com/anthropics/claude-code/issues/34836) |
| ASAR + `child_process.spawn` 冲突，必须 `asarUnpack` 或启动时解压 | [electron#9459](https://github.com/electron/electron/issues/9459)、[electron#26708](https://github.com/electron/electron/issues/26708) |
| macOS 签名/公证要覆盖 243MB 二进制 | — |
| 包体积暴增：每 platform×arch 一个 243MB | — |

预计需要：`asarUnpack` 平台包 + 传 `pathToClaudeCodeExecutable` 指向真实路径 + 从子进程 env 里清掉 `ELECTRON_RUN_AS_NODE` + 可能用自定义 `spawnClaudeCodeProcess` 拿全控制。SDK 提供 `spawnClaudeCodeProcess` / `pathToClaudeCodeExecutable` 作为 escape hatch。

### 🟡 中风险

#### 5. Auth 模型变了（全新耦合点）

现在 catmax **完全不管 API key** —— auth 全权委托给用户装的 claude CLI 自己的凭据库。代码里 grep 不到任何 `ANTHROPIC_API_KEY` 处理。

SDK 默认要 `ANTHROPIC_API_KEY` 或 OAuth token，且 **Anthropic TOS 明确禁止第三方产品用 claude.ai 订阅登录**：

> *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Please use the API key authentication methods…"*

迁移意味着：
- 要么用户必须配 API key（UX 退步，现在"装了 claude 就能用"的体验没了）
- 要么用 Bedrock/Vertex/Foundry
- 需要在 settings 里新增 key 配置项和 keychain 读写

#### 6. stream-json 解析层要重写（但映射层可复用）

- `claude/protocol.ts`（`parseClaudeLine`/`LineBuffer`/`encodeUserMessage`）—— **整个不用了**，SDK 直接给 typed `SDKMessage`
- `claude-schema.ts`（5 种 raw message 的 zod schema）—— **不用了**
- `mapping.ts`（tool name → ToolCallInfo，content block → TurnEvent）—— **大部分可复用**，因为 SDK 消息内容块与 CLI stream-json 同构；只需改 mapper 的输入源
- `StreamEventAggregator` —— **可能可删**（SDK 可能直接给 text delta）
- `TurnEvent` 输出形状不变，**UI 层基本不感知**

#### 7. AskUserQuestion 的 "new turn + --resume" workaround

`ChatView.vue:466-468`、`AskUserQuestionDialog.vue:7` 有个 claude 特有 hack：因为 `-p` 模式不接受外部 `tool_result` 回写，回答 AskUserQuestion 必须**起一个全新 turn**。

> 注释原文：*"claude -p 模式不接受外部 tool_result 回写，所以走新一轮 turn + --resume"*

SDK 下大概率可以 inline 回答，能简化这个 workaround，但属于行为变更，需要重新测试 UX 流。

### 🟢 低风险 / 能复用

#### 8. jsonl 磁盘读取（最可能白捡）

`jsonl-reader.ts`、`encodeCwdToProjectDir`、history 回放——**SDK 写的就是同一个 `~/.claude/projects/<encoded-cwd>/*.jsonl` 格式**（同一个二进制写的）。这套大概率原样可用，是迁移里唯一几乎免费的部分。包括：
- `listClaudeSessionsFromDisk`、`readClaudeSessionJsonl`、`readHistoryFromJsonl`
- `resolveSubagentJsonlPath`、`readSubagentHistory`
- `history-mapping.ts` 的 slash-command/compact 检测启发式

#### 9. 零碎 UI 分支

`backend === 'claude'` 的 UI 分支、`BackendIcon.vue`、capability flags 形状、`message.ts` 的 approval 路由 —— 都 carry over。

---

## 七、风险矩阵：现有耦合点 × 迁移代价

| 耦合点 | 关键文件 | 代价 |
|---|---|---|
| CLI flags → SDK options | `adapter.ts:306-396` | 🟡 直接映射 |
| per-turn spawn → 长进程 | `process-spawner.ts`、`adapter.ts:402-413,643-675` | 🔴 架构重写 |
| **ApprovalBridge/MCP/socket** | `approval-bridge.ts`、`mcp/*`、`adapter.ts:335-396,606-697` | 🔴 **最大重写（但结果更简单）** |
| stream-json 解析 | `protocol.ts`、`claude-schema.ts` | 🟡 重写输入，保留 mapping |
| jsonl 磁盘读取 | `jsonl-reader.ts` | 🟢 基本复用 |
| session_id dance | `adapter.ts:286-323`、`manager.ts:54-64` | 🔴 重新设计 |
| 二进制路径/healthCheck | `adapter.ts:153-177`、`health-check.ts` | 🟢 删掉（codex 仍用 helper） |
| **Electron 打包 SDK 二进制** | 新增 | 🔴 **全新问题** |
| **API key auth** | 新增 | 🟡 **全新耦合** |
| AskUserQuestion workaround | `ChatView.vue:466-468` | 🟡 可简化 |

---

## 八、替代方案对比

迁移 SDK 不是缓解"运行中改配置"痛点的唯一路径。按 ROI 排序：

| 方案 | 解决热切换 | 工作量 | 风险 | 备注 |
|---|---|---|---|---|
| **A. ApprovalBridge 加"临时全放行"开关** | 权限 ✅ / model·effort ❌ | 小（纯 catmax 侧，几十行） | 低 | 不改 mode 本身，在 `handlePermissionRequest` 里对后续请求自动批准。**最快见效** |
| **B. "interrupt + 新参数 + --resume 续跑"一键按钮** | 全部 ✅（但中断当前生成） | 中 | 低 | 利用现有 `--resume` 续上下文。代价：被中断回合的生成内容基本丢失 |
| **C. 完整迁移 Agent SDK** | model·permission ✅ / effort ⚠️ | 大（见上） | 高 | 引入 Electron 打包 + auth 两个新硬伤 |
| **D. SDK streaming-input 模式最小 PoC** | model·permission ✅ | 中 | 中 | 先不动 UI，隔离环境验证 SDK 在本 Electron 打包下能否跑通 |

---

## 九、结论与建议

### 为什么暂不整体迁移

1. **SDK 没消除 subprocess，只是包装了它** —— 期待的"in-process 彻底简化"并不存在，底层还是 spawn 二进制
2. **引入两个当前没有的硬伤**：
   - Electron 打包 243MB 二进制（ASAR/signing/包体积）
   - 强制 API key 认证（UX 退步 + 可能触 Anthropic TOS）
3. **最大工作量（ApprovalBridge 重写）回报有限** —— 现有 socket 方案虽复杂但能跑；SDK 的 `canUseTool` 更优雅，但属于"好做但不必须"
4. **SDK 仍在 0.x**，semver 不稳，每周多次发布

### 推荐路径

```
先做 A（立即缓解权限痛点）
   ↓
评估 B（覆盖 model/effort，代价是中断当前生成）
   ↓
只有当确实需要 steer / 长进程 / 降低 spawn 开销等更多收益时
   ↓
用 D 做 PoC：在隔离环境验证 Agent SDK 在本 Electron + electron-vite + ASAR 打包下能否 spawn
   ↓
PoC 通过再决定是否做 C（完整迁移）
```

### SDK 真正值得迁移的触发条件

如果将来同时满足以下条件，值得重新评估迁移：

- 需要 steer（运行中给 Claude 插话纠偏）成为一等公民
- per-turn spawn 的冷启动开销成为可感知的延迟
- 愿意接受 API key 认证模型（或上 Bedrock/Vertex）
- Electron 打包方案能干净处理 bundled 二进制

---

## 参考来源

### Agent SDK 官方

- 概述（含"bundle native binary"原话）：https://code.claude.com/docs/en/agent-sdk/overview
- TypeScript reference（`query()` / `Query` / `setModel()` / `setPermissionMode()` / `applyFlagSettings()` / `startup()` / `canUseTool`）：https://code.claude.com/docs/en/agent-sdk/typescript
- 权限（`permissionMode` / `canUseTool` / `permissionPromptToolName` 互斥）：https://code.claude.com/docs/en/agent-sdk/permissions
- 会话（`resume`/`continue`/`fork`、jsonl 路径）：https://code.claude.com/docs/en/agent-sdk/sessions
- 迁移指南（改名、默认 system prompt 变更）：https://code.claude.com/docs/en/agent-sdk/migration-guide
- npm：https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk
- TS 仓库 / CHANGELOG：https://github.com/anthropics/claude-agent-sdk-typescript
- Python 仓库：https://github.com/anthropics/claude-agent-sdk-python
- 官方 demos：https://github.com/anthropics/claude-agent-sdk-demos

### Electron 集成已知问题

- `spawn node ENOENT` after packaging：https://github.com/anthropics/claude-code/issues/4383
- ASAR + `require.resolve` 打包问题：https://github.com/anthropics/anthropic-sdk-typescript/issues/865
- `ELECTRON_RUN_AS_NODE` 泄漏：https://github.com/anthropics/claude-code/issues/34836
- Electron ASAR + `child_process.spawn`：https://github.com/electron/electron/issues/9459、https://github.com/electron/electron/issues/26708

### 社区参考

- Electron + SDK starter：https://github.com/vanzan01/claude-agent-sdk-starter
- SDK 实践踩坑：https://liruifengv.com/posts/claude-agent-sdk-pitfalls-en/

### 项目内相关文档

- 《会话状态隔离与流式事件路由》—— 三种 id（catmax session.id / backendThreadId / turnId）的路由机制
- 《Codex App 与 codex CLI 的通信方式》—— codex 的长存活 JSON-RPC 模型，是 SDK-based claude adapter 的形态参照
