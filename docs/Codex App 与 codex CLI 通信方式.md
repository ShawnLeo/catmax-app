# Codex App 与 codex CLI 的通信方式

> 基于 OpenAI 官方 `codex-rs/app-server/README.md`、维护者在 GitHub Discussion #1174 的直接说明，以及社区深度技术分析整理。
>
> **核心结论**：通信协议是 **JSON-RPC 2.0（双向流式）**，传输层为 **stdio（默认，稳定）** 和 **WebSocket（实验性）**。Electron 主进程把 `codex` 二进制作为子进程 spawn，通过 stdio 交换换行分隔的 JSON-RPC 帧。

---

## 目录

- [一、`codex app-server` 是什么](#一codex-app-server-是什么)
- [二、三种传输方式对比](#二三种传输方式对比)
- [三、Codex Desktop（Electron）的具体连接流程](#三codex-desktopelectron的具体连接流程)
- [四、协议生命周期：Thread / Turn / Item 三层模型](#四协议生命周期thread--turn--item-三层模型)
- [五、这个设计为什么聪明](#五这个设计为什么聪明)
- [六、与 Claude Code 的对比](#六与-claude-code-的对比)
- [七、对自研 code agent 的落地启发](#七对自研-code-agent-的落地启发)
- [参考来源](#参考来源)

---

## 一、`codex app-server` 是什么

不是一个新的二进制，而是**同一个 `codex` Rust 二进制的子命令**：

```bash
# 默认 stdio 模式
codex app-server

# 或显式指定
codex app-server --listen stdio://

# WebSocket 模式（实验性，"一个 flag 就成网络服务"）
codex app-server --listen ws://127.0.0.1:4500
```

OpenAI 官方对其定位：

> *"The Codex App Server is a **JSON-RPC protocol that exposes the Codex harness** for integration with the web app, IDE extensions, etc."* —— @OpenAIDevs

它把 codex 的核心 **agent loop（harness）** 暴露成一个 **stateful、长生命周期的服务**，让 Web/Desktop/IDE 多端**复用同一套逻辑**，避免每个客户端各自重写 agent。

---

## 二、三种传输方式对比

| 传输 | 启动命令 | 状态 | 典型场景 |
|------|---------|------|---------|
| **stdio**（默认） | `codex app-server` | ✅ 稳定 | **Codex Desktop、VS Code 扩展**、Promptfoo、T3 Code、OpenClaw |
| **WebSocket** | `--listen ws://127.0.0.1:4500` | ⚠️ 实验性 | dev container、浏览器 UI、远程接入 |
| **Unix domain socket** | 内部，监听 `$CODEX_HOME/app-...` | 内部 | "companion" 持久进程模式，复用同一 server |

**关键点**：三种传输跑的是**完全相同的 JSON-RPC 协议**——传输层是可替换的。

---

## 三、Codex Desktop（Electron）的具体连接流程

```
┌──────────────────────────────────────────────────────────┐
│  Electron Main Process (Node.js)                        │
│                                                          │
│  spawn('codex', ['app-server', '--listen', 'stdio://'])  │
│         │                                                │
│         ▼                                                │
│  ┌──────────────────────┐                                │
│  │ child.stdin.write()  │ ── newline-delimited JSON ──►  │
│  │ child.stdout.on()    │ ◄── newline-delimited JSON ──  │
│  └──────────────────────┘                                │
└──────────────────────────┬───────────────────────────────┘
                           │ stdio (stdin/stdout)
                           ▼
┌──────────────────────────────────────────────────────────┐
│  codex (Rust binary, codex-rs/app-server)                │
│                                                          │
│  • 解析 JSON-RPC 请求                                     │
│  • 驱动 agent loop                                        │
│  • 流式发送 notification（turn/started, item更新...）      │
│  • 接收客户端的 approval / sandbox 控制请求                 │
└──────────────────────────────────────────────────────────┘
```

### 帧格式

**换行分隔的 JSON-RPC 2.0**（newline-delimited JSON）

注意一个细节：线上传输时**省略 `"jsonrpc":"2.0"` header** 以节省字节，但语义仍是 JSON-RPC 2.0。社区形容为：

> *"JSON-RPC-shaped, but not strict JSON-RPC 2.0 on the wire."*

---

## 四、协议生命周期：Thread / Turn / Item 三层模型

协议围绕**三层抽象**组织：

```
initialize (握手)
    │
    ▼
┌─────────────────────────────────────────┐
│ Thread (长生命周期对话上下文)              │
│  thread/start, thread/list, ...         │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │ Turn (一次 agent 运行)             │  │
│  │  turn/start                       │  │
│  │   │                               │  │
│  │   ▼                               │  │
│  │  [notification 流]                 │  │
│  │   turn/started                    │  │
│  │   item/* (token输出、工具调用...)  │  │
│  │   turn/completed (最终消息)        │  │
│  │                                     │  │
│  │  ◄── 客户端可反向发送:              │  │
│  │       approval / sandbox 控制      │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

### 1. 握手阶段

```
Client → Server:  initialize
Server → Client:  返回 capabilities
Client → Server:  initialized
```

### 2. Turn 运行期间的流式通知

服务端在 turn 运行期间**持续推送 notification**：

```
Server → Client:
  turn/started
  item/*           ← token 流、工具调用、文件 diff 等
  item/*
  ...
  turn/completed   ← 最终消息
```

### 3. 双向：客户端可反向控制

这不只是单向推送。客户端能**在 turn 运行中途**发回：

- **approval**——批准/拒绝 agent 的某个操作
- **sandbox 控制**——调整沙箱策略
- **中断请求**

这就是为什么叫 "**bidirectional** port"——真正的双向通信。

---

## 五、这个设计为什么聪明

### 1. 一个 harness，多端复用

```
            ┌──► Codex Web (容器内)
            │
codex app-server ──┼──► Codex Desktop (Electron, 本地)
            │
            ├──► VS Code 扩展
            │
            └──► 第三方 (Promptfoo, Sublime 插件, 自建 harness)
```

**所有客户端跑同一个 agent loop**，逻辑零重复。bolinfest（OpenAI 维护者）原话：

> *"Currently, the de facto wire protocol is what is defined in `codex-rs/core/src/protocol.rs`"*

### 2. 与 MCP 同构（降低学习成本）

官方 README 明说：

> *"**Similar to MCP**, codex app-server supports bidirectional communication using JSON-RPC 2.0 messages"*

这意味着：
- 熟悉 MCP 的开发者**几乎零学习成本**就能集成 Codex
- 协议设计借鉴了 MCP 的成熟模式

### 3. "One flag away from a network service"

来自社区深度分析 [depletionmode.com](https://depletionmode.com/codex-on-the-wire/) 的标题。一句话：

```bash
codex app-server                              # 本地 stdio
codex app-server --listen ws://0.0.0.0:4500   # 加一个 flag 就成网络服务
```

**同一套协议、同一套代码**，从本地子进程秒变远程网络服务——这给 dev container、云端执行、多用户共享等场景开了无限可能。

### 4. 官方还提供 Codex 作为 MCP server

codex-rs 还能**作为 MCP server** 运行。OpenAI 维护者 bolinfest 原话：

> *"we also provide Codex as an MCP server... the two are already so similar (bidirectional streams of newline-delimited-JSON payloads)"*

所以接入方式有**两条路径**：

- **app-server 协议**（JSON-RPC，专为 rich client 设计）
- **MCP server 模式**（让别的 agent 把 Codex 当工具调用）

---

## 六、与 Claude Code 的对比

| 维度 | Codex（app-server） | Claude Code |
|------|---------------------|-------------|
| **后端** | Rust 二进制 | TypeScript / Node.js |
| **UI 与后端通信** | **JSON-RPC over stdio/WebSocket** | IPC（Electron 内部，或同进程） |
| **协议** | 开放的 wire protocol（文档化） | 内部 |
| **多客户端复用** | ✅ Web/Desktop/IDE 共用一个 server | 主要为 CLI 自身 |
| **第三方可集成** | ✅ 任意语言 spawn 子进程即可 | 受限 |
| **与 MCP 关系** | 协议同构 + 也能当 MCP server | 作为 MCP client |

**Codex 的协议是"一等公民"**——OpenAI 把它当作公开接口，鼓励第三方集成。这是 Rust 重写公告里列的四大动机之一：

> *"Extensible Protocol — we've been working on a 'wire protocol' for Codex CLI to allow developers to **extend the agent in different languages** (including Type/JavaScript, Python, etc) and MCPs"*

---

## 七、对自研 code agent 的落地启发

这个架构有几个**可以直接抄**的设计：

### 1. 核心逻辑 = 可独立启动的 server

不要把 agent loop 写死在 CLI 里。提供一个 `myagent app-server --listen stdio://` 子命令，让任何客户端能接入。

### 2. JSON-RPC over newline-delimited JSON

这是 MCP、LSP、Codex 共同的选择——简单、跨语言、易调试。比 gRPC 轻量、比 HTTP 流式友好。

### 3. 传输层可替换（stdio ↔ WebSocket）

同一份协议代码，支持两种传输：

- 开发期：stdio（最简单）
- 生产期：WebSocket（远程、多客户端）

### 4. 双向流 + 三层模型（Thread/Turn/Item）

- **Thread**：长对话
- **Turn**：一次运行
- **Item**：流式输出单元
- 客户端能在中途反向控制（approval、中断、sandbox 调整）

### 5. 与 MCP 协议同构

直接借鉴 MCP 的消息格式，降低社区接入成本。

---

## 参考来源

### 官方文档

- [GitHub – codex-rs/app-server/README.md（协议权威文档）](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [GitHub Discussion #1174 – Codex CLI is Going Native（含维护者对 wire protocol 的说明）](https://github.com/openai/codex/discussions/1174)
- [OpenAI 官方 – Harness Engineering](https://openai.com/index/harness-engineering/)
- [@OpenAIDevs – App Server 公告](https://x.com/OpenAIDevs/status/2019221475849564657)
- [GitHub – codex-rs/core/src/protocol.rs（wire protocol 定义）](https://github.com/openai/codex/blob/main/codex-rs/core/src/protocol.rs)

### 深度技术分析

- [depletionmode.com – Codex on the Wire: One Flag Away From a Network Service（最深入的协议分析）](https://depletionmode.com/codex-on-the-wire/)
- [gist – A developer's guide to OpenAI Codex's JSON-RPC interface（握手/方法/生命周期）](https://gist.github.com/oneryalcin/ee2c27e2d8aa040da8fbe7eebcc2ecea)

### 实战集成参考

- [Promptfoo – OpenAI Codex App Server Provider](https://www.promptfoo.dev/docs/providers/openai-codex-app-server/)
- [libraries.io – codex-app-server-sdk（Python SDK，支持 stdio/WebSocket）](https://libraries.io/pypi/codex-app-server-sdk)
- [Reddit r/ChatGPTPro – How Codex Works Under the Hood](https://www.reddit.com/r/ChatGPTPro/comments/1s7t5am/how_codex_works_under_the_hood_app_server_remote/)

---

*文档整理日期：2026-07-18*
