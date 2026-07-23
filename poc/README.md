# PoC 验证脚本

这个目录保存了 claude 后端 Agent SDK 迁移过程中的关键验证实验脚本。
**不删除**——出问题时可重跑复现、或借鉴思路。

每个脚本独立可跑，互不依赖。都是 `.mjs`（ESM），用项目里已安装的 SDK。

## 运行前提

所有脚本都需要**已 claude 登录**（subscription 或 API key）。SDK 自带 binary，
会用 `~/.claude` 下的凭证，不需要额外配置。

```bash
# 在项目根目录跑（这样能 resolve 到 node_modules 里的 @anthropic-ai/claude-agent-sdk）
node poc/01-askuserquestion-gating.mjs
node poc/02-askuser-mcp-tool.mjs
node poc/03-canusetool-rich-info.mjs
```

> ⚠️ 这些脚本不在 tsconfig include 范围内（不会被 typecheck），
> 也被 eslint ignore（`ignorePatterns: ['poc/']`，见 .eslintrc.cjs）——
> 因为它们 import SDK 但不在 tsconfig project 里，typed-linting 会崩。
> 这是故意的：PoC 是一次性验证脚本，不走项目的类型/lint 流水线。

---

## 脚本清单

### `01-askuserquestion-gating.mjs` — ❌ 失败的实验（保留作警示）

**验证**：内置 `AskUserQuestion` 工具在 Agent SDK headless 模式下能否触发；
以及 streaming-input 注入 mid-turn user message 的行为。

**结论**：
- `AskUserQuestion` **永远不进 tools 列表**（被 CLI 的 `isInteractive` 门控）。
  无论 `-p` 模式还是 SDK streaming-input 模式，tools=40，没有这个工具。
  试了 `CLAUDE_CODE_INTERACTIVE=1` 等 env 都绕不过。
- streaming-input 注入 mid-turn user message **被接受**，但产生的是新的 assistant turn，
  不是"在同一 turn 内回答 agent 的问题"。

**意义**：证明"往正在跑的 turn 注入答案"这条路对 `AskUserQuestion` 无意义——
工具本身不可用。相关死代码（AskUserQuestionDialog / fanOutAskUserQuestion /
ask_user_question 事件等）已清理。**正确的解法见 02。**

---

### `02-askuser-mcp-tool.mjs` — ✅ 成功（生产实现的原型）

**验证**：自定义 in-process `ask_user` MCP 工具在 headless SDK 下可行。

**结论**：
- `type:'sdk'` 的 in-process `McpServer` **无需手动 transport** 即可被 SDK 接入。
- `ask_user` **进 init 的 tools 列表**（`mcp__catmax__ask_user`）——证明自定义 MCP 工具
  **不受 `isInteractive` 门控**（与内置 `AskUserQuestion` 不同）。
- 模型**自主调用** `ask_user`（给模糊任务"配置日志"，模型分析项目后会主动问澄清问题）。
- handler 阻塞等答案 → 答案作为 `tool_result` 回流 → 模型读取答案并继续。

**意义**：这是 Agent SDK 下"agent 问用户问题"的正确实现方式。
内置 `AskUserQuestion` 不可用，用自定义 MCP 工具替代。
**生产实现**：`src/main/backend/claude/ask-user-server.ts` + adapter 的 `mcpServers.catmax` 注入。

**脚本说明**：用 `setTimeout` 3 秒后自动回答（模拟用户）。生产代码里是
QuestionPanel → `respondQuestion` IPC → `adapter.respondQuestion` → resolve handler promise。

---

### `03-canusetool-rich-info.mjs` — ✅ 透传权限富信息的依据

**验证**：SDK `canUseTool` 回调 `options` 参数携带的"富信息"。

**结论**：`canUseTool(toolName, input, options)` 的 `options` 带：
- `displayName`："Write"（友好动作名，适合按钮）
- `description`："/tmp/x.txt"（目标的人类可读描述）
- `decisionReason`："Path is outside allowed working directories"（为什么问）
- `title`："Claude wants to ..."（bridge 渲染好的完整句）
- `suggestions: PermissionUpdate[]`：**approve_always 时应原样作为
  `PermissionResult.updatedPermissions` 回传**，让"本会话都允许"真正持久化。

**意义**：之前 app 只用了 `toolName`+`input`，丢掉了这些。透传后：
权限面板能显示 SDK 原生友好文案，且 `approve_always`（"本会话都允许"）真正生效
（之前被 collapse 成 `allow`，SDK 不知道要持久化，下次还会问）。
**生产实现**：`mapping.ts` 的 `claudePermissionToApprovalRequest(toolName, input, meta)`
和 `adapter.ts` 的 `canUseTool`（存 suggestions、approve_always 回传 updatedPermissions）。

---

## 关键技术结论汇总

（这些是跑 PoC + 通读 sdk.d.ts 得出的，写代码时直接参考）

### Agent SDK 用户交互的通道（headless 模式）

| 通道 | 触发场景 | 结论 |
|------|---------|------|
| `canUseTool` | 每次工具执行前 | ✅ **主力交互面**，稳定触发，options 带富信息 |
| `onUserDialog` | CLI 主动弹阻塞对话框 | ⚠️ 极少触发（plan 审批都不走它，走 canUseTool） |
| `onElicitation` | MCP server 要用户填表/认证 | 仅 MCP，内置工具不走 |

### 不存在的东西（全文 grep 确认）
- ❌ `isInteractive` / `rendererMode` / `headless` 开关 —— SDK 默认就是 headless
- ❌ 内置 `AskUserQuestion` 工具（被 `isInteractive` 门控，headless 下不可用）
- ❌ 原生"agent 主动请求用户输入自由文本"API

### "agent 问用户问题"的正确实现
自定义 MCP 工具（in-process，`type:'sdk'`）+ async handler 阻塞等答案 +
答案作为 `tool_result` 回流。system prompt 用 `{type:'preset', preset:'claude_code', append}`
追加引导语（不覆盖默认 prompt）。
