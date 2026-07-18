# OpenAI Codex App 技术解析

> 基于 Codex.app v26.212.1823（build 661, Electron 40.0.0）的逆向工程分析，结合 OpenAI 官方工程文档整理。
>
> **核心结论**：Codex App 不是一个 "ChatGPT 套壳"，而是一个**本地开发平台**——以 `codex` CLI（Rust 二进制）为后端核心，用 Electron 包了一层窗口 UI，并把 git、代码智能、定时任务、多编辑器集成作为一等公民。LLM 只是其中一个组件。

---

## 目录

- [一、三层进程架构](#一三层进程架构)
- [二、六大核心设计决策](#二六大核心设计决策)
- [三、沙箱设计](#三沙箱设计)
- [四、认证系统](#四认证系统)
- [五、完整技术栈](#五完整技术栈)
- [六、为什么这个架构能成立](#六为什么这个架构能成立)
- [七、对自研 code agent 的启发](#七对自研-code-agent-的启发)
- [参考来源](#参考来源)

---

## 一、三层进程架构

Codex 是**三进程架构**，最关键的是**层与层之间的边界设计**：

```
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│ Layer 1: RENDERER   │  │ Layer 2: MAIN       │  │ Layer 3: RUST CLI   │
│ (Chromium Webview)  │  │ (Node.js)           │  │ (codex binary)      │
├─────────────────────┤  ├─────────────────────┤  ├─────────────────────┤
│ React 18            │  │ better-sqlite3      │  │ tree-sitter         │
│ ProseMirror         │  │ node-pty            │  │ starlark            │
│ Radix UI           ◄──┤ WebSocket client     ◄──┤ rmcp (MCP)          │
│ Shiki               │  │ Sparkle updater      │  │ sqlx-sqlite         │
│ cmdk                │  │ Sentry              │  │ oauth2 + keyring    │
│ Framer Motion       │  │ Immer + Zod         │  │ tokio runtime       │
│ D3 / Mermaid        │  │ mime-types          │  │ reqwest + hyper     │
│ KaTeX / Cytoscape   │  │ shlex               │  │ OpenTelemetry       │
└─────────────────────┘  └─────────────────────┘  └─────────────────────┘
       IPC                        stdio / WS
6.5 MB JS bundle         SQLite threads DB         208 Rust crates
300 KB CSS               File-based sessions       Mach-O arm64
433 lazy chunks          PTY shell sessions        OpenAI API calls
```

### 双 SQLite 设计的精妙之处

- `better-sqlite3`（同步）在 Node.js 主进程 → 存 UI 状态（automations、inbox、global_state）
- `sqlx-sqlite`（异步）在 Rust 二进制 → 存对话数据（threads、thread_memory、logs）
- **刻意分库**：避免跨进程数据库锁竞争，每个层拥有自己的数据域

### Schema 分域

| 归属 Rust 二进制 | 归属 Node.js 主进程 |
|------------------|---------------------|
| threads、thread_memory、thread_dynamic_tools、logs | automations、automation_runs、inbox_items、global_state |

`automation_runs.thread_id` 桥接两个域——automation 运行时在 Rust 数据库创建 thread，再在 Node.js 数据库记录引用。

---

## 二、六大核心设计决策

### 设计 1：CLI-as-Backend（最重要）

桌面 App **不含**自定义 Rust 后端，它包裹的是 Homebrew 上同一个 `codex` CLI：

```bash
codex app-server --port <port>
```

**含义**：终端 CLI 和桌面 App 共享同一核心 —— 改一处两边都受益。Electron 层只负责窗口、ProseMirror 编辑器和 OAuth2 认证，**智能在 Rust 里**。

---

### 设计 2：IPC Handler Registry（70 个方法的 RPC 服务器）

大多数 Electron App 的 IPC 是散落在各文件的 `ipcMain.handle(...)`。Codex 采用**集中式处理器注册表**——一个把 70 个方法名映射到 async handler 的对象：

```js
// 渲染层调用看起来像在调 REST API
const result = await ipcRenderer.invoke("git-push", { branch: "main", force: false });
const info   = await ipcRenderer.invoke("account-info");
const file   = await ipcRenderer.invoke("read-file", { path: "/src/index.ts" });
```

#### 70 个方法的六大域分布

| 域 | 方法数 | 示例 |
|----|-------|------|
| **Git & PR** | 14 | push、branch、merge-base、worktree 快照、`gh pr create` |
| **Automation** | 11 | 自动化 CRUD、立即运行、归档、inbox |
| **File & Environment** | 12 | 读/选文件、config 解析、agents.md |
| **Workspace** | 8 | 多根管理、置顶 thread、标题生成 |
| **Skills** | 3 | 发现、安装、移除 |
| **System** | 22 | auth、state、config、telemetry、editor 启动 |

#### 三个关键设计点

1. **渲染层零业务逻辑**——不知道 git 怎么工作、文件在哪、token 怎么刷新
2. **每个 handler 收到 `origin` 参数**——支持多窗口和 per-window 状态
3. **VS Code 兼容桥**（`vscode://codex/`）路由进同一套 handler——同一渲染代码可在 Electron 和 VS Code 内运行

---

### 设计 3：Fetch Proxy 认证网关

渲染层**不直接调 `fetch()`**，而是通过主进程的代理：

```
Renderer: { type: "fetch-request", url: "/backend-api/...", method: "POST", body: "..." }
   ↓ IPC
Main: 拦截 → 注入 auth header → electron.net.fetch()
   ↓
Main: { type: "fetch-response", status: 200, body: "..." }
   ↓ IPC
Renderer: 接收
```

#### 代理做的四件关键事

1. **自动注入认证**：目标是 `*.openai.com` / `*.chatgpt.com` 时自动加 `Authorization: Bearer <token>` 和 `ChatGPT-Account-Id`——**渲染层永远看不到原始 token**
2. **Token 刷新**：收到 401 时自动调用 `getAuthToken({ refreshToken: true })` 重试一次——对渲染层完全透明
3. **VS Code 协议桥**：`vscode://codex/` 开头的 URL 被拦截路由到 handler registry
4. **相对 URL 解析**：裸路径按 `CODEX_API_BASE_URL` 解析（生产 `chatgpt.com`，开发 `localhost:8000`）

这是移动 App 处理认证的标准模式——**渲染层是"哑"客户端**。

---

### 设计 4：Git 作为事实之源（而非文件系统）

大多数 AI 工具把"文件夹"当作上下文边界。Codex 更深一层：**git 是上下文边界，不是文件系统**。

#### 为什么这是根本性的

- "一个文件夹"是模糊的——是 repo 根？子目录？monorepo 的某个 package？哪些文件该忽略？
- **Git 给出全部答案**：`git status` 知道 tracked/modified/untracked；`git-merge-base` 知道 diff 基线；`.gitignore` + `ignore` crate 知道该忽略什么

#### 对 AI agent 的三个关键含义

1. **安全回滚**——agent 改错了，git 提供 undo。`apply-patch` handler 能原子地应用或回退补丁

2. **基于快照的云端执行**——这是 Codex 跑云端任务的核心机制：
   ```
   prepare-worktree-snapshot → 打包整个 working tree 成 tarball
   upload-worktree-snapshot  → 上传到 OpenAI 基础设施
   ```
   **不逐个文件同步，而是快照整个 git 状态**——只有 git 能给出"这个项目是什么"的清晰边界

3. **PR 原生工作流**——agent 能端到端执行完整开发周期（branch → 改 → commit → push → `gh pr create`）

#### 配置层的精妙选择：Starlark

- 使用 `.codex/environments/*.toml`（就近原则，离 working dir 最近者胜）
- 配置脚本用 **Starlark**（Google Bazel 用的确定性 Python 子集）
- **为什么用 Starlark**：保证无 I/O、无 import、无系统调用——因为 agent 会评估来自任意 repo 的不可信配置，**必须在数学上可证明安全**

---

### 设计 5：自动化引擎（内置 cron）

Codex 把完整的 cron/automation 系统**做进了桌面 App**（非服务端特性）。SQLite schema：

```sql
CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  next_run_at INTEGER,
  last_run_at INTEGER,
  cwds TEXT NOT NULL DEFAULT '[]',   -- 每个工作区的工作目录列表
  rrule TEXT                           -- RFC 5545 重复规则（同 iCal）
);

CREATE TABLE automation_runs (
  thread_id TEXT PRIMARY KEY,          -- 每次运行创建一个对话 thread
  automation_id TEXT NOT NULL,
  status TEXT NOT NULL,
  inbox_title TEXT,
  inbox_summary TEXT
);

CREATE TABLE inbox_items (...);        -- 完成的运行进入 inbox
```

#### 关键点

- **RRule 调度**——RFC 5545 重复规则，代码库中 `rrule` 出现 62 次，是完整功能的调度（不只是简单间隔）
- **Per-workspace CWDs**——同一 prompt 能对多个 repo 运行
- **Inbox 模型**——运行产出带标题和摘要的 inbox 项，有归档/删除流程
- **Thread 集成**——每次运行创建对话 thread，可事后审查 agent 做了什么

#### 实际场景

"每天早上 review 这个 repo 的开放 PR" 或 "每周五更新依赖"——全部从桌面运行，无需服务端调度器。

---

### 设计 6：编辑器集成层

支持 **16 种编辑器**：

```
vscode, vscodeInsiders, cursor, zed, sublimeText, bbedit,
textmate, windsurf, antigravity, xcode, androidStudio,
intellij, goland, rustrover, pycharm, webstorm
```

`open-file` handler 实现：
- per-editor 启动逻辑（带行/列定位）
- 每个工作区记忆首选编辑器
- 智能回退（二进制文件如 PDF 回退到系统文件管理器）

#### VS Code 协议兼容的暗示

```js
const ik = "vscode://codex/";
handleVSCodeRequest(origin, method, params)  // 路由到同一 handler registry
```

强烈暗示 Codex 的 webview **原本就设计为既能独立 Electron 运行，也能嵌入 VS Code**。

---

## 三、沙箱设计

根据 InfoQ 报道和 OpenAI 官方 Harness Engineering 文档：

- Codex 把 agent 放进**沙箱**，约束它能操作的位置、能访问的文件
- **每个任务一个 Git worktree**——并行任务互不干扰
- Windows 上 OpenAI 自己设计了 native 沙箱架构（工程权衡有详细披露）
- 设计哲学：**"agents 在有严格边界和可预测结构的环境中最高效"**——Codex 复刻已有的工程模式而非发明新范式

### 沙箱权限模型（来自 `codex-rs/core/src/protocol.rs`）

```rust
pub enum SandboxPermission {
    DiskFullReadAccess,                 // 读全盘
    DiskWritePlatformUserTempFolder,    // 写用户临时目录
    DiskWritePlatformGlobalTempFolder,  // 写系统临时目录
    DiskWriteCwd,                       // 写当前工作目录
    DiskWriteFolder { folder: PathBuf },// 写指定文件夹
    DiskFullWriteAccess,                // 写全盘
    NetworkFullAccess,                  // 任意网络请求
}
```

### 跨平台沙箱实现

| 平台 | 机制 |
|------|------|
| **macOS** | `/usr/bin/sandbox-exec`（seatbelt，基于正则的路径白名单） |
| **Linux** | 自研 CLI，基于 **Landlock + seccomp** |

策略应用到整个进程树（父进程及所有子进程）。

---

## 四、认证系统

比"存个 API key"复杂得多：

| 方面 | 实现 |
|------|------|
| **JWT 结构** | payload 含 `api.openai.com/auth`（account ID、user ID、plan type）和 `api.openai.com/profile`（email） |
| **存储位置** | Rust 二进制用 `keyring` crate 存进 **macOS Keychain**，不是配置文件或 Electron `safeStorage` |
| **OAuth2 回调** | `tiny_http` crate 起临时本地 HTTP server 接 OAuth2 redirect；`oauth2` crate 管理 **完整 PKCE 流程** |
| **域白名单** | auth header 仅对 `localhost`、`*.openai.com`、`*.chatgpt.com` 附加；`ab.chatgpt.com`（Statsig A/B 测试）被显式排除 |

---

## 五、完整技术栈

### Layer 1：渲染层

| 选择 | 值得注意的点 |
|------|-------------|
| **ProseMirror**（不是 Monaco） | 自定义 node 类型内联展示 tool 调用、文件 diff、图表——同 Notion/NYT 的引擎 |
| React 18 + Radix UI + cmdk | 标准 accessible 组件 + ⌘K 命令面板 |
| xterm.js | 内置终端模拟器 |
| unified/remark/rehype | AST-based Markdown 管道 |
| Shiki（400+ 懒加载语法） | 语法高亮 |
| Mermaid / D3 / Cytoscape / KaTeX | 图表、可视化、数学 |

### Layer 2：主进程

| 包 | 用途 |
|----|------|
| `better-sqlite3` | 本地线程/会话存储（同步） |
| `node-pty` | 真伪终端，执行 shell 命令 |
| `ws` + `bufferutil` + `utf-8-validate` | 与 Rust 后端的 WebSocket 通信 |
| `@sentry/electron` + `@sentry/node` | 崩溃报告 + 错误追踪 |
| `immer` | 不可变状态更新 |
| `lodash` + `memoizee` | 工具函数 + memoize |
| `zod` (v4.1) | 运行时 schema 校验 |
| `smol-toml` | 解析 `.codex/` 的 TOML 配置 |
| `shlex` | Shell 命令分词 |
| `socks-proxy-agent` | 企业网络的 SOCKS 代理支持 |
| `mime-types` + `which` | 文件类型检测 + 二进制查找 |

### Layer 3：Rust CLI（208 crates）

| 类别 | crates | 用途 |
|------|--------|------|
| **代码智能** | tree-sitter、tree-sitter-highlight、pulldown-cmark、similar、diffy、ignore | AST 解析、Markdown、diff、gitignore 感知遍历 |
| **配置** | starlark、starlark_syntax、starlark_map、toml、toml_edit、serde_yaml | Starlark runtime + TOML/YAML 配置 |
| **网络** | reqwest、hyper、hyper-rustls、eventsource-stream、tiny_http | HTTP client/server、SSE 流、OAuth 回调 |
| **异步运行时** | tokio、tokio-stream、tokio-util、futures-util、async-channel | 并发任务执行 |
| **协议** | rmcp | 原生 MCP（Model Context Protocol）客户端 |
| **存储** | sqlx-core、sqlx-sqlite | Rust 端异步 SQLite 持久化 |
| **认证 & 安全** | oauth2、keyring、ring、rustls | OAuth2 PKCE、OS keychain、TLS |
| **文件系统** | notify、fsevent-sys、globset | 文件监听（macOS FSEvents）、glob 匹配 |
| **终端** | portable-pty、process-wrap、signal-hook | PTY 管理、进程控制、信号处理 |
| **媒体** | image、png、tiff、zune-jpeg、fax | 图像处理和格式支持 |
| **压缩** | zip、zstd-safe、bzip2、xz2、flate2 | worktree 快照的归档处理 |
| **编码** | chardetng、encoding_rs、base64 | 字符检测、编码转换 |
| **可观测性** | sentry、opentelemetry、opentelemetry-otlp、tracing、tracing-subscriber | 错误报告 + 分布式追踪 |
| **系统** | os_info、sys-locale、system-configuration、chrono | 平台内省 |

---

## 六、为什么这个架构能成立

六个设计形成一个**自洽系统**：

```
CLI-as-backend ──► 桌面/终端共享核心，改一处两边受益
       │
IPC registry ────► 渲染层是纯 UI，零业务逻辑（清晰域边界）
       │
Fetch proxy ─────► 认证完全透明，无 token 管理，自动刷新
       │
Git as truth ────► agent 真正理解 repo 结构（不是文件系统）
       │
Automation ──────► 从聊天工具升级为开发平台（后台调度 + inbox）
       │
Editor layer ────► 桥接 16 个 IDE，VS Code 协议暗示双宿主未来
```

**最深刻的洞察**：**Codex 不是带 API key 的聊天 App**。它是一个本地开发平台，LLM 只是众多组件之一——git 集成、代码智能、workspace 管理、定时自动化同样根本。

---

## 七、对自研 code agent 的启发

如果做自己的 code agent，可以直接借鉴这些设计：

1. **后端用 Rust 二进制 + 桌面用 Electron 包壳**——而不是把所有逻辑塞进 Node.js
2. **集中式 IPC 注册表 + Zod schema 校验**——清晰的 RPC 边界，渲染层零业务逻辑
3. **fetch 代理网关**——token 永不暴露给渲染层，401 自动刷新
4. **git 作为上下文边界**——比"打开文件夹"语义清晰得多
5. **Starlark 处理不可信配置**——数学上可证明安全
6. **双 SQLite（同步 UI + 异步对话）**——避免跨进程锁
7. **`vscode://` 协议桥**——同一 UI 可在独立 App 和 IDE 内运行

---

## 参考来源

**核心逆向分析**：
- [yuanjiwei.com – The Architecture Behind OpenAI's Codex Desktop App（最深入的逆向分析）](https://yuanjiwei.com/20250215-architecture-behind-codex/)

**官方工程文档**：
- [OpenAI 官方 – Harness Engineering: Leveraging Codex in an Agent-First World](https://openai.com/index/harness-engineering/)
- [InfoQ – How OpenAI Built a Secure Windows Sandbox for Codex](https://www.infoq.com/news/2026/06/codex-windows-sandbox-design/)
- [GitHub – codex-rs/core/src/protocol.rs（沙箱权限定义）](https://github.com/openai/codex/blob/main/codex-rs/core/src/protocol.rs)
- [GitHub – codex-rs/linux-sandbox/README.md](https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md)

**高层架构**：
- [ByteByteGo – How OpenAI Codex Works](https://blog.bytebytego.com/p/how-openai-codex-works)
- [ZenML – Building Production-Ready AI Agents: Codex CLI Architecture](https://www.zenml.io/llmops-database/building-production-ready-ai-agents-openai-codex-cli-architecture-and-agent-loop-design)

**社区讨论**：
- [Latent Space – Codex App is NOT a VS Code fork](https://www.latent.space/p/ainews-openai-codex-app-death-of)
- [Hacker News – OpenAI 工程师 Romain 确认 Electron 选型原因](https://news.ycombinator.com/item?id=46859054)
- [Cobus Greyling – OpenAI Codex Sandboxing](https://cobusgreyling.medium.com/openai-codex-sandboxing-53fbcf61ed40)

---

*文档整理日期：2026-07-18*
*分析版本：Codex v26.212.1823, build 661, Electron 40.0.0, macOS 15.6, Apple M4*
