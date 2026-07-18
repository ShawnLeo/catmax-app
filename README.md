# catmax-app

> 一个自用的、Electron + Vue3 桌面 code agent 客户端，通过可插拔的后端协议适配器同时支持 [codex](https://github.com/openai/codex) 和 [claude code](https://claude.ai/code)。
>
> 借鉴 [Codex App](https://openai.com/index/introducing-the-codex-app/) 的架构思想（CLI-as-Backend、集中式 IPC Registry、Git-as-Truth、可插拔后端），但用 Vue3 而非 React 实现。

---

## ✨ 核心能力

| 能力 | 说明 |
|---|---|
| 🤖 **双后端 code agent** | 一键切换 `codex` / `claude`，会话按后端分区（可继续 vs 只读） |
| 💬 **流式聊天** | Markdown 渲染 + Shiki 语法高亮 + tool call 卡片 + approval 弹窗 + 中断 |
| 📁 **工作区模型** | 多工作区管理，绑定本地文件夹作为 CWD |
| 🗂 **会话持久化** | SQLite 索引 + settings.json（Zod 校验） |
| 🌳 **文件树**（只读） | gitignore 感知，Shiki 高亮预览 |
| 🌿 **Git Status 面板**（只读） | 分支、staged/unstaged/untracked、最近 5 条 commit |
| 🖥 **内置终端** | xterm.js + node-pty，多实例，自适应 resize |
| 🔧 **编辑器集成** | VS Code / Cursor / IntelliJ / WebStorm / Sublime，`file:line:column` 定位 |
| ⌨️ **⌘K 命令面板** | 插件化命令注册系统 + 模糊搜索 + 键盘导航 |
| 🎨 **可扩展主题** | 三层 token + OKLCH + `data-theme` 属性，深/浅/跟随系统 |
| 🔐 **凭证加密存储** | Electron safeStorage（macOS Keychain / Windows DPAPI） |

---

## 🏗 架构

三层进程模型，借鉴 Codex App：

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 1: RENDERER  (Vue3 + Pinia + Tailwind v4 + shadcn-vue)    │
│   零业务逻辑 — 所有副作用走 IPC                                   │
└────────────────────────────┬────────────────────────────────────┘
                             │ Heckmann 模式 IPC（类型自动派生）
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 2: MAIN  (Node.js + Electron)                             │
│   8 个 IPC domain + BackendManager + Codex/Claude Adapter       │
│   + better-sqlite3 + node-pty + simple-git                      │
└────────────────────────────┬────────────────────────────────────┘
                             │ spawn + newline-delimited JSON
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 3: BACKEND  (codex app-server / claude CLI，可替换)        │
└─────────────────────────────────────────────────────────────────┘
```

**关键设计**：
- **`AgentBackend` 抽象** — UI 永远只见 `TurnEvent` / `NormalizedMessage`，不见后端协议原文。加新后端 = 加新 Adapter，UI 零修改
- **集中式类型化 IPC** — handler 函数签名即契约，类型从 main → preload → renderer 自动派生，契约永不漂移
- **三层 token 主题** — Layer 1 原始 / Layer 2 语义 / Layer 3 组件，加主题不改组件代码

详见 [`docs/superpowers/specs/2026-07-18-catmax-app-design.md`](docs/superpowers/specs/2026-07-18-catmax-app-design.md)。

---

## 🚀 快速开始

### 前置要求

- **Node.js** ≥ 20.19
- **pnpm** ≥ 10
- **codex CLI**（可选，要 codex 后端）：`npm install -g @openai/codex`
- **claude code CLI**（可选，要 claude 后端）：参照 [claude.ai/code](https://claude.ai/code) 安装

两个后端都不强制——只装一个也能用，UI 会自动隐藏未安装的后端。

### 安装与运行

```bash
# 克隆
git clone <repo-url> catmax-app
cd catmax-app

# 安装依赖（含 native modules：better-sqlite3 + node-pty）
pnpm install

# 启动 dev（首次会自动 rebuild native modules for Electron）
pnpm dev
```

### 首次使用

1. App 启动后，在 Welcome 页选择一个本地文件夹作为工作区
2. 进入聊天界面，左侧 Sidebar 选择后端（codex 或 claude）
3. 在 Composer 输入消息开始对话

### 后端凭证

- **codex**：首次使用前在终端跑 `codex login`（OAuth 流程），App 会复用凭证
- **claude**：首次使用前在终端跑 `claude login`，App 会复用凭证

或者，在 App 的"设置 → 凭证管理"里直接填 API key（用 Electron safeStorage 加密存储）。

---

## 🛠 开发命令

```bash
pnpm dev              # 启动 dev server（HMR + Electron）
pnpm build            # production build（输出到 out/）
pnpm typecheck        # TS 类型检查（node + web 双 tsconfig）
pnpm lint             # ESLint 检查
pnpm lint:fix         # ESLint 自动修复
pnpm format           # Prettier 格式化
pnpm test             # 跑全部测试（vitest）
pnpm test:watch       # watch 模式

# native module 维护（双 ABI 处理）
pnpm rebuild:native   # 为 Electron 重编 better-sqlite3 + node-pty（dev/build 前）
pnpm rebuild:node     # 为 Node 重编（test 前，因为 vitest 跑在 Node 下）
```

**为什么需要双 ABI？** Electron 和 Node 用不同的 V8 版本，native module（better-sqlite3、node-pty）需要分别编译。`pnpm dev` / `pnpm build` 已经自动调 `rebuild:native`，但跑 `pnpm test` 前需要手动 `pnpm rebuild:node`。

---

## 📂 项目结构

```
catmax-app/
├─ docs/                              # 文档
│  ├─ Codex App 技术解析.md            # Codex 逆向分析（设计参考）
│  ├─ Codex App 与 codex CLI 通信方式.md
│  └─ superpowers/
│     ├─ specs/                       # 设计文档（单一真源）
│     └─ plans/                       # 分阶段实施计划（5 个 plan + smoke test）
│
├─ .agents/skills/catmax-conventions/ # 项目规范技能（防止代码发散）
│  ├─ SKILL.md
│  └─ references/                     # architecture / coding-style / ipc-pattern /
│                                     # backend-adapter / ui-conventions
│
├─ electron.vite.config.ts            # electron-vite 单一配置点
├─ package.json
├─ tsconfig.{json,node,web}.json      # 三 tsconfig（main/preload/shared + renderer）
│
└─ src/
   ├─ shared/                         # ★ 跨进程类型契约（仅类型和常量）
   │  ├─ backend/                     # AgentBackend 接口 + codex/claude schema
   │  ├─ ipc/                         # 8 个 domain 的 IPC 契约
   │  ├─ constants.ts                 # BackendId / IPC channels / 存储键名
   │  ├─ domain.ts                    # Workspace / Session / Message 领域类型
   │  └─ settings-schema.ts           # AppSettings Zod schema
   │
   ├─ main/                           # 主进程
   │  ├─ backend/                     # 后端实现
   │  │  ├─ manager.ts                # BackendManager 单例
   │  │  ├─ codex/                    # CodexAdapter（JSON-RPC/stdio）
   │  │  ├─ claude/                   # ClaudeAdapter（stream-json）
   │  │  └─ process-spawner.ts        # spawn 封装（便于测试）
   │  ├─ ipc/
   │  │  ├─ typed.ts                  # Heckmann 模式类型化 IPC
   │  │  └─ domains/                  # 8 个 domain：workspace/settings/system/
   │  │                               # backend/session/git/fs/pty
   │  └─ service/                     # 业务服务
   │     ├─ database.ts               # better-sqlite3
   │     ├─ settings-store.ts         # settings.json + Zod
   │     ├─ pty-manager.ts            # node-pty 实例池
   │     ├─ git-service.ts            # simple-git（只读）
   │     ├─ file-tree.ts              # gitignore 感知遍历
   │     ├─ editor-launcher.ts        # 5 个 IDE 启动
   │     └─ credential-store.ts       # Electron safeStorage
   │
   ├─ preload/
   │  └─ api.ts                       # 从 shared/ipc/* 自动派生 api 对象
   │
   └─ renderer/src/                   # Vue3 渲染层
      ├─ stores/                      # Pinia（workspace/session/message/backend/
      │                               # settings/ui/git/files/terminal）
      ├─ composables/                 # useTheme / useStreamMessage / useTerminal / useShortcut
      ├─ components/
      │  ├─ chat/                     # MessageList / Composer / MarkdownView / ToolCallCard / ApprovalDialog
      │  ├─ sidebar/                  # Sidebar / WorkspaceSwitcher / SessionList / BackendIndicator
      │  ├─ panel/                    # RightPanel / GitPanel / FileTree / FilePreview / TerminalPanel
      │  ├─ command/                  # CommandPalette (⌘K)
      │  └─ ui/                       # shadcn-vue 基础组件（Button / Input）
      └─ lib/                         # markdown / shiki / commandRegistry / format
```

---

## 🧪 测试

```bash
pnpm rebuild:node     # 先切到 Node ABI（双 ABI 处理）
pnpm test
```

当前 **152 个自动化测试**覆盖：

- **shared/**：constants、settings-schema（Zod 校验）
- **service/**：database（CRUD + FK cascade）、settings-store、git-service、file-tree、editor-launcher、pty-manager
- **backend/**：codex 协议解析、event 映射、CodexAdapter（mock spawn 完整流程）、claude schema/mapping/adapter
- **ipc/**：typed IPC、workspace/settings handlers

测试不依赖真实 codex/claude CLI——通过 mock spawn + fixture 隔离。

---

## 🎨 主题系统

三层 token 架构（参考 shadcn/ui + Tailwind v4）：

```
Layer 1: 原始 token（OKLCH 色板原料）
Layer 2: 语义 token（★ 组件唯一能引用的层，如 --background / --primary）
Layer 3: 组件 token（按需，如 --sidebar-background / --code-block-background）
```

切换主题：改 `<html data-theme="dark|light|system|...">`，CSS 变量自动重算。

加新主题：在 `src/renderer/src/assets/styles/themes.css` 加一段 `[data-theme="xxx"] { ... }` 块，组件代码零修改。

详见 [`.agents/skills/catmax-conventions/references/ui-conventions.md`](.agents/skills/catmax-conventions/references/ui-conventions.md)。

---

## 🔌 加新后端（如 Aider）

得益于 `AgentBackend` 抽象，加新后端只需：

1. 在 `src/shared/backend/types.ts` 的 `BackendId` 加新值
2. 新建 `src/main/backend/<id>/{adapter,protocol,mapping}.ts`
3. 实现 `AgentBackend` 接口（`initialize/startSession/startTurn/interrupt/respondApproval/...`）
4. 在 `BackendManager` 构造函数注册
5. 在 `BackendCapabilities` 声明支持哪些功能（UI 据此显隐）

**UI 完全零修改**——因为依赖抽象，不依赖具体后端。详见 [`.agents/skills/catmax-conventions/references/backend-adapter.md`](.agents/skills/catmax-conventions/references/backend-adapter.md)。

---

## 📜 项目规范

为防止代码发散，所有架构 + 编码规范固化为项目级 ZCode 技能：

```
.agents/skills/catmax-conventions/
├─ SKILL.md                         # 五条硬性规则 + 反模式
└─ references/
   ├─ architecture.md               # 三层进程、目录约定、跨层 import 规则
   ├─ coding-style.md               # 命名、TS 配置、ESLint/Prettier、Vue SFC
   ├─ ipc-pattern.md                # IPC 三件套（契约/handler/注册）+ 6 步流程
   ├─ backend-adapter.md            # AgentBackend 接口 + 新适配器步骤
   └─ ui-conventions.md             # shadcn-vue + 主题系统 + 组件命名
```

**五条硬性规则**：
1. 渲染层零业务逻辑——`src/renderer/` 绝不 import `electron` 或 Node 内置
2. 新增系统操作必须先定义 IPC 契约，不能让 Vue 直接调 Node
3. Adapter 必须实现 `AgentBackend` 接口，UI 永远不见后端协议原文
4. Zod 只用在不可信输入（子进程消息、磁盘 JSON、HTTP），不用在 IPC 参数
5. 时间用 Unix 毫秒，id 用 UUID v4

---

## 📋 开发流程

本项目用 superpowers 工作流（brainstorming → writing-plans → subagent-driven-development）：

1. **设计阶段**：`docs/superpowers/specs/` 写设计文档
2. **计划阶段**：`docs/superpowers/plans/` 写分阶段 plan（每个 plan 含完整 TDD task）
3. **实施阶段**：每个 task 派 subagent 实现 + spec/quality reviewer
4. **验证阶段**：每个 plan 配一份 smoke test 清单

历史 plan（已全部实施完成）：
- [Plan 1: Foundation](docs/superpowers/plans/2026-07-18-plan-1-foundation.md) — 地基 + IPC + 主题 + 持久化
- [Plan 2: Backend + Chat](docs/superpowers/plans/2026-07-18-plan-2-backend-and-chat.md) — Codex 适配器 + 聊天 UI
- [Plan 3: Claude + Sidebar](docs/superpowers/plans/2026-07-18-plan-3-claude-and-sidebar.md) — Claude 适配器 + 完整侧边栏
- [Plan 4a: Git + Files + Editor](docs/superpowers/plans/2026-07-18-plan-4a-git-files-editor.md) — 文件系统相关
- [Plan 4b: Terminal + Cmd-K](docs/superpowers/plans/2026-07-18-plan-4b-terminal-and-cmdk.md) — 终端 + 命令面板

---

## 🛣 路线图

MVP 14 项能力已全部完成。后续规划的方向（未实现）：

- **会话历史回放** — 当前 `session.detail` 返回空消息，需要实现 codex rollout / claude session json 的解析
- **自动化引擎（cron）** — 借鉴 Codex 的 RRule 调度，定时跑 agent
- **Inbox 系统** — 后台运行结果进入 inbox 审查
- **Cloud worktree 快照** — 基于 git 的云端执行（prepare/upload snapshot）
- **跨后端会话迁移** — 把 codex 会话 fork 到 claude
- **自研 agent loop** — 不依赖 codex/claude CLI，直接调 LLM API
- **多窗口** — 每个工作区独立窗口
- **Linux 支持** — 当前 macOS + Windows
- **OAuth2 PKCE** — 自有账号系统（如果要对外发布）

---

## 📄 许可证

私有项目（自用）。

---

## 🙏 致谢

- [OpenAI Codex](https://github.com/openai/codex) — 架构灵感来源
- [Codex App 逆向分析](docs/Codex%20App%20技术解析.md) — 设计参考
- [shadcn-vue](https://www.shadcn-vue.com/) — UI 组件模式
- [electron-vite](https://electron-vite.org/) — 构建工具
- [Heckmann 的 Type-safe IPC 模式](https://heckmann.app/en/blog/electron-ipc-architecture) — IPC 类型派生
