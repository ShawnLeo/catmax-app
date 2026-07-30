# 后端协议转换（Protocol Bridge）调研与架构方案

- **状态**：Phase 1+2 已实现（Responses ↔ Anthropic + 本地桥）；Chat Completions codec 未实现
- **日期**：2026-07-29
- **范围**：codex 后端接入只提供 Chat Completions 的第三方上游；为后续 Anthropic Messages 等协议预留扩展位
- **参考实现**：cc-switch `src-tauri/src/proxy/providers/`（Rust，本地 HTTP 代理内做转换）

---

## 1. 结论速览

1. **Responses 和 Chat Completions 不是"同一个 API 的两种写法"**，差异不止字段命名：请求是有状态 vs 无状态、工具调用是独立 item vs 挂在 message 上、流式是语义事件 vs 增量分片。真正的难点全在流式和多轮工具循环上。
2. **catmax 目前没有承载转换的通道**。cc-switch 能转换是因为它本身是个本地 HTTP 代理，codex 的 `base_url` 指向它。catmax 是直接 spawn `codex app-server`，codex 直连上游，中间没有 catmax 的位置。**要做协议转换，必须先在主进程里起一个本地 HTTP 服务**，这是最大的一块新增工作量。
3. **没有"零成本基线"——codex 已经把 `wire_api = "chat"` 彻底删掉了**（见 §2.0）。自研转换桥不是"比原生方案更好"，而是**接入 Chat Completions 上游的唯一途径**。这一条把整个方案的性质从"可选优化"变成了"要么做要么放弃这类上游"。
4. **扩展性建议走 IR 中心辐射（hub-and-spoke），不要走两两配对**。catmax 的真实矩阵是 2 个客户端协议（codex=Responses、claude=Anthropic）× N 个上游协议，两两配对是 2N 个模块，IR 方案是 N×2 个 codec 覆盖 N² 个组合，**每加一个协议的成本从 2N 降到 2**。IR 的保真度风险用「原始 item 逐字保留的 opaque 通道」兜底。

---

## 2. 两个协议的差异

### 2.0 前置事实：codex 已删除 chat 协议支持（2026-07-29 核实）

| 时间                  | 事件                                                                                             | 出处                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| 2025-12-09            | 官方宣布弃用 `chat/completions`，CLI 开始打弃用警告                                              | [openai/codex discussion #7782](https://github.com/openai/codex/discussions/7782) |
| 2026-02-01            | 支持期结束，配置 `wire_api = "chat"` 变成**硬错误**                                              | 同上（维护者评论）                                                                |
| 当前（codex 0.146.x） | 官方配置参考：**"`responses` is the only supported value, and it is the default when omitted."** | [Config Reference](https://learn.chatgpt.com/docs/config-file/config-reference)   |

官方给出的弃用理由是维护 legacy 协议"增加了复杂度、引入了回归、抬高了支持成本"；对第三方供应商的建议是直接上 Responses（并点名 LM Studio 已支持、Ollama 在计划中）。

而且**删除之前它就已经不好用了**：[openai/codex#9679](https://github.com/openai/codex/issues/9679) 记录了 `wire_api = "chat"` 接 OpenRouter / OneAPI 时，上游返回 200 但客户端报 `Item [UUID] not found in turn state` 直接不显示输出，该 issue 以 _closed as not planned_ 收场。这正好印证了 §3 里那些"看着像细节"的坑（item id 稳定性、turn state 一致性）是真会让整条链路挂掉的。

**对本方案的影响**：

- 原先设想的"先用 codex 原生 chat 路径试试、够用就不写代码"的第 0 期**不存在**。
- 网上 2025 年的教程里大量 `wire_api = "chat"` 配置片段现在全是废的，用户照抄会直接报错——转换桥同时也解决了这个用户侧的迁移痛点。
- 反过来说，这让 catmax 的转换桥有了明确且持久的价值：只要第三方上游还在提供 Chat Completions（短期内不会消失），codex 就永远需要一层桥。cc-switch 存在的理由也正是这个。
- 但也意味着**桥必须自己扛全部保真度**，没有原生路径可以兜底或对照。

### 2.1 全景对照

| 维度         | Chat Completions                                                                                                                           | Responses                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| 端点         | `POST /v1/chat/completions`                                                                                                                | `POST /v1/responses`（codex 还会用 `/v1/responses/compact`）                            |
| 系统提示     | `messages[0].role = "system"`（或 `developer`）                                                                                            | 独立顶层字段 `instructions`                                                             |
| 对话载荷     | `messages: Message[]`                                                                                                                      | `input: Item[] \| string`                                                               |
| 会话状态     | **完全无状态**，每次带全量历史                                                                                                             | **可有状态**：`store` + `previous_response_id`，允许只发增量                            |
| 工具定义     | 嵌套 `{type:"function", function:{name,description,parameters}}`                                                                           | 扁平 `{type:"function", name, description, parameters, strict}`                         |
| 工具调用     | 挂在 assistant 消息上：`message.tool_calls[]`                                                                                              | **独立 item**：`{type:"function_call", id, call_id, name, arguments}`                   |
| 工具结果     | 独立消息 `{role:"tool", tool_call_id, content:string}`                                                                                     | 独立 item `{type:"function_call_output", call_id, output}`                              |
| 工具结果类型 | **只能是字符串**                                                                                                                           | 可以是结构化值 / 多模态块                                                               |
| 特殊工具     | 无                                                                                                                                         | `custom_tool_call`（自由文本入参）、`tool_search_call`、`namespace` 工具                |
| 思考控制     | `reasoning_effort`（OpenAI 系）；第三方各家自创 `thinking` / `enable_thinking` / `reasoning_split`                                         | `reasoning: { effort, summary }`                                                        |
| 思考回传     | **非标准**：`delta.reasoning_content`（DeepSeek/Kimi）、`delta.reasoning`、`reasoning_details`，或直接在 `content` 里塞 `<think>…</think>` | 标准 `{type:"reasoning", summary:[{type:"summary_text",text}], encrypted_content}` item |
| 多模态输入   | `{type:"image_url", image_url:{url}}`                                                                                                      | `{type:"input_image", image_url}` / `input_file` / `input_audio`                        |
| 输出上限     | `max_tokens`（o 系用 `max_completion_tokens`）                                                                                             | `max_output_tokens`                                                                     |
| 用量字段     | `prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens`                                                              | `input_tokens` / `output_tokens` / `input_tokens_details.cached_tokens`                 |
| 流式用量     | **默认不返回**，必须显式 `stream_options.include_usage = true`                                                                             | 默认在 `response.completed` 里带                                                        |
| 流式结束     | `data: [DONE]`                                                                                                                             | `event: response.completed`                                                             |
| 缓存键       | `prompt_cache_key`（部分家支持，多数网关见到就 400）                                                                                       | `prompt_cache_key`                                                                      |

### 2.2 流式：差异最大的地方

**Chat Completions** 是"一条流水线上的增量分片"，所有内容混在 `choices[0].delta` 里：

```
data: {"id":"chatcmpl-x","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}
data: {"id":"chatcmpl-x","choices":[{"delta":{"reasoning_content":"让我想想"}}]}
data: {"id":"chatcmpl-x","choices":[{"delta":{"content":"好的"}}]}
data: {"id":"chatcmpl-x","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":""}}]}}]}
data: {"id":"chatcmpl-x","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"pa"}}]}}]}
data: {"id":"chatcmpl-x","choices":[{"delta":{},"finish_reason":"tool_calls"}]}
data: {"usage":{...}}          ← 仅当 include_usage
data: [DONE]
```

**Responses** 是"带生命周期的语义事件"，每个输出块是一个有 `output_index` / `item_id` 的独立 item，且**必须先 added 再 delta 再 done**：

```
event: response.created
event: response.in_progress
event: response.output_item.added          {output_index:0, item:{type:"reasoning", id:"rs_..."}}
event: response.reasoning_summary_part.added
event: response.reasoning_summary_text.delta
event: response.reasoning_summary_text.done
event: response.reasoning_summary_part.done
event: response.output_item.done
event: response.output_item.added          {output_index:1, item:{type:"message", id:"msg_..."}}
event: response.content_part.added
event: response.output_text.delta
event: response.output_text.done
event: response.content_part.done
event: response.output_item.done
event: response.output_item.added          {output_index:2, item:{type:"function_call", id:"fc_...", call_id:"call_1", name:"read"}}
event: response.function_call_arguments.delta
event: response.function_call_arguments.done
event: response.output_item.done
event: response.completed                  {response:{usage:{...}}}
```

cc-switch 把这套输出信封单独抽成一个模块（`codex_responses_sse.rs:1-14`），注释写得很直白：两个转换器（从 Chat 来的和从 Anthropic 来的）**输入状态机完全不同，但必须吐出一模一样的 Responses 事件流**，所以信封只写一份，避免两边漂移。这是整个仓库里最值得抄的一条结构决策。

Chat → Responses 的状态机因此要负责：

- 分配并维护 `output_index` 单调递增、`item_id` 合成（Chat 侧根本没有 item id）
- 见到第一个 delta 前补发 `output_item.added`，流结束前补发 `output_item.done`（cc-switch 用 `next_tool_index_to_add` 保证按序 added，见 `streaming_codex_chat.rs:67-113`）
- Chat 的 `tool_calls[].index` → Responses 的 `output_index` 映射
- reasoning 和 text 的**边界切换**：Chat 侧 reasoning 和 content 可以交错，Responses 侧必须先关掉 reasoning item 才能开 message item
- `finish_reason` → `response.completed` / `response.failed`；上游流没给 finish_reason 就断了，要合成一个终态（cc-switch 在 `streaming_codex_chat.rs:804-820` 分三种情况兜底：正常完成 / 有实质输出但截断→`length` / 什么都没有→`stream_truncated` 失败事件）

---

## 3. 转换中真正会丢东西的地方

这一节是 cc-switch 代码里注释最密的部分，基本每条都是踩过的坑。

### 3.1 `previous_response_id`：有状态 → 无状态

codex 经常这样发后续请求：`previous_response_id` + 只带一个 `function_call_output`。Chat 上游无状态，拿不到前面的 assistant tool_call 消息，DeepSeek 这类上游会直接报错（它要求 tool 结果前面必须紧跟对应的 assistant tool_call + `reasoning_content`）。

cc-switch 的解法是一个**跨请求缓存** `CodexChatHistoryStore`（`codex_chat_history.rs:30-43`）：从上游返回流里抓下每个 response 的 function_call item，按 `response_id` 存起来（LRU 512 条），下次见到 `previous_response_id` 就把缺失的 call 补回去；`previous_response_id` 缺失或被改写时（subagent 场景）退化成按 `call_id` 唯一匹配。

**这是必须实现的**，不是优化项。

### 3.2 reasoning 的归属

Responses 的 `reasoning` 是独立 item，Chat 侧只能挂成 assistant 消息的 `reasoning_content` 字段。哪条 reasoning 属于哪条 assistant 消息，需要一个 pending 队列**前向附挂**：reasoning 先进 pending，附给它后面的 message 或 function_call。

cc-switch 在这里写了大段注释（`transform_codex_chat.rs:711-720`）说明为什么不能回溯附挂到上一条 assistant——会把新一轮的思考错拼进旧消息，导致思考型模型多轮对话"断片"。收尾时剩余的 pending 才回溯附挂，且遇到 user 消息（回合边界）时不允许跨回合泄漏。

### 3.3 加密思考的往返

OpenAI 的 `reasoning.encrypted_content` 在别的协议里没有对应字段。cc-switch 的 `reasoning_bridge.rs` 用一个通用招法：**把整个 reasoning item 序列化 + base64，塞进目标协议的不透明字段**（Anthropic 的 thinking signature / redacted_thinking），客户端回放时再解出来。前缀 `ccswitch-openai-reasoning-v1:` 做版本标记。

这个思路应该**上升为架构机制**，而不是一处特例 —— 见 §6 的 `IrOpaque`。

### 3.4 `<think>` 标签

不少第三方 Chat 上游不返回 `reasoning_content`，而是直接在 `content` 里吐 `<think>…</think>`。流式下开标签可能被切成 `<th` + `ink>`，所以要有一个三态检测状态机（`Detecting` / `Reasoning` / `Text`，见 `streaming_codex_chat.rs:41-53`）带前缀缓冲，判定出来再决定这段是 reasoning 还是 text。

### 3.5 工具名与 namespace

Chat Completions 的 function name 限 64 字符且字符集受限。codex 0.142+ 会发 `{"type":"namespace",…}` 形态的工具，扁平化成 `ns__name` 后可能超长、也可能和别的工具撞名。cc-switch 用 `CodexToolContext` 在**请求转换时**建立「Chat 工具名 → 原始 Responses 工具 spec」的映射，**响应转换时**再按这张表还原 namespace/custom/tool_search 元数据 —— 所以 `CodexToolContext` 必须从请求侧传到流式转换器（`create_responses_sse_stream_from_chat_with_context`）。

同理 `custom_tool_call`（自由文本入参）在 Chat 侧没有对应物，要降级成一个只有 `input: string` 参数的普通 function，并把原始工具定义塞进 description 里（`CUSTOM_TOOL_PRESERVED_METADATA_HEADING`），响应回来再还原成 `custom_tool_call`。

### 3.6 工具结果里的多模态

Responses 的 `function_call_output` 可以带图片；Chat 的 `role:"tool"` 消息只能是字符串。cc-switch 把媒体抽出来（`tool_media.rs`），在 tool 消息里留一个 `TOOL_RESULT_MEDIA_MOVED_MARKER` 占位，再**在下一条 assistant 之前插一条合成的 user 消息**承载图片。顺序很讲究，`flush_pending_chat_tool_media` 的调用点散在好几处。

### 3.7 各家上游的怪癖（都得留配置位）

| 上游            | 坑                                        | cc-switch 的处理                                                                                                     |
| --------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| MiniMax         | `system` 只允许出现在首条                 | `collapse_system_messages_to_head` 把所有 system 合并到开头（`transform_codex_chat.rs:497-527`）                     |
| vLLM / 企业网关 | `tools` 为空时带 `tool_choice` 会 400/503 | 转换后 tools 空则删掉 `tool_choice` 和 `parallel_tool_calls`                                                         |
| OpenRouter      | effort 枚举无 `max`，发了就 400           | `map_reasoning_effort` 的 `openrouter` 模式钳到 `xhigh`                                                              |
| DeepSeek        | effort 只认 `high`/`max`                  | `deepseek` 模式                                                                                                      |
| 多数第三方      | 流式不返回 usage                          | 强制注入 `stream_options.include_usage`                                                                              |
| 多数网关        | 不认 `prompt_cache_key`，见到就 400       | 白名单：只对 `api.openai.com` 和 `api.kimi.com/coding` 发                                                            |
| 各家            | 思考开关字段名不同                        | `CodexChatReasoningConfig { thinking_param, effort_param, effort_value_mode, output_format }` 做成 per-provider 配置 |

**结论：转换器不能只有一套硬编码规则，必须有 per-provider 的能力/怪癖配置。** 这条要进架构。

---

## 4. cc-switch 的实现结构

```
proxy/providers/
  codex.rs                      判定：这个 provider 的上游说什么协议（apiFormat / wire_api / base_url 猜测）
  transform_codex_chat.rs       Responses 请求 → Chat 请求；Chat 非流式响应 → Responses 响应   (4347 行)
  streaming_codex_chat.rs       Chat SSE → Responses SSE（状态机）                              (1256 行)
  codex_chat_common.rs          两个方向共用的小工具（reasoning 字段嗅探、<think> 切分）
  codex_chat_history.rs         previous_response_id 的跨请求补全缓存
  codex_responses_sse.rs        ★ Responses SSE 输出信封（唯一真源，两个转换器共用）
  reasoning_bridge.rs           不透明 reasoning 的 base64 封装/解封
  transform_codex_anthropic.rs  Responses → Anthropic                                          (3020 行)
  streaming_codex_anthropic.rs  Anthropic SSE → Responses SSE
  tool_media.rs（在 proxy/）     工具结果里的多模态搬运
```

分派点在 `handlers.rs:848-870` 和 `forwarder.rs:1149-1151`：按 `(请求路径, provider 声明的上游协议)` 二元组选转换分支。

### 值得借鉴的四条

1. **输出信封单独成模块**（`codex_responses_sse.rs`）——多个来源协议共享同一个目标协议的输出格式，格式修一次就够。
2. **转换是"白名单重建"而不是"原地改"**——`responses_to_chat_completions` 从 `json!({})` 起手，逐个 copy 已知字段。未知字段默认丢弃（`store` / `include` / `previous_response_id` / `text` 都被丢了），比"删掉几个已知不兼容字段"安全得多。
3. **请求侧的上下文要传给响应侧**——`CodexToolContext` 是请求转换的产物，也是响应还原的输入。转换器不是无状态的纯函数对。
4. **能力差异做成配置而不是分支**——`CodexChatReasoningConfig` 让"这家用 `enable_thinking` 那家用 `thinking`"变成数据。

---

## 5. catmax 的前置问题：没有承载转换的通道

cc-switch 是这样的：

```
codex CLI ──HTTP──> cc-switch 本地代理(:port) ──HTTP──> 真实上游
                    ↑ 转换在这里
```

catmax 现在是这样的：

```
catmax main ──spawn/JSON-RPC──> codex app-server ──HTTP──> 真实上游
                                                   ↑ catmax 完全看不见这一段
```

`codex app-server` 是个黑盒子进程，它的 HTTP 出流量不经过 catmax。所以**协议转换的前提是 catmax 主进程里跑一个本地 HTTP 服务**，并把 codex 的 `model_providers.<name>.base_url` 指向它。

必要组件：

- `node:http` 起一个只绑 `127.0.0.1`、端口随机的 server（不加新依赖）
- 启动时生成一次性 token，写进 codex 配置的 `env_key` / header，请求校验，防止本机其他进程蹭这个转发口
- 把 codex 的 provider 配置指过来。两条路：
  - **A. 写 `~/.codex/config.toml`** —— 加一个 `[model_providers.catmax-bridge]`，`base_url = "http://127.0.0.1:<port>/v1"`、`wire_api = "responses"`，并把 `model_provider` 切过去。持久、但改用户的文件（我们已有备份+原子写+冲突检测机制可复用）。
  - **B. 用 `CODEX_HOME` 指向一个 catmax 托管的临时配置目录** —— 完全不碰用户的 `~/.codex`，但会连带隔离掉用户的 sessions/skills/auth，代价太大。
  - 倾向 A，且**只增不改**：新增一个专用 provider 条目，用户原有配置保持不动，切换只动 `model_provider` 一行。
- 上游凭证：catmax 有"不存任何凭证"的既定原则（见 CLAUDE.md）。转换桥需要拿到上游的 key 才能转发。**建议沿用同一原则**：key 只存在于用户自己的 `~/.codex/config.toml`（`env_key` 指向的环境变量）里，catmax 在 spawn codex 时把它读进内存转发，不落任何 catmax 自己的存储。这一点要在实现前明确确认。

**这块工作量不小，且和转换逻辑本身正交。** 建议作为独立一期。

---

## 6. 提议的架构

### 6.1 为什么是 IR 中心辐射而不是两两配对

catmax 的真实矩阵不是 1×N：

| 客户端                     | 客户端协议         | 可能的上游协议                     |
| -------------------------- | ------------------ | ---------------------------------- |
| codex                      | OpenAI Responses   | Responses(直通) / Chat / Anthropic |
| claude                     | Anthropic Messages | Anthropic(直通) / Chat / Responses |
| 未来 pi agent / grok build | ?                  | ?                                  |

两两配对：每加一个协议要写 2N 个模块（N 是已有协议数）。
IR 中心辐射：每加一个协议写 1 个 codec（含 decode/encode 两侧），自动获得和所有已有协议的互通。

保真度是 IR 的传统弱点，用两个机制兜住：

- **`vendor` 逐字保留袋**：decode 时把整个原始请求体存进 `IrRequest.vendor`，同协议直通时直接用原体，不走 encode 重建。
- **`IrOpaque` 不透明块**：任何目标协议表达不了的东西（`encrypted_content`、item id、namespace 元数据）原样封进块里带着走，回到原协议时解封还原。这是把 cc-switch `reasoning_bridge.rs` 的特例做法上升成通用机制。
- **逃生舱**：注册表允许登记「A→B 的直接转换器」覆盖 IR 路径，用于 IR 实在表达不了、又值得单独优化的组合。

### 6.2 契约草案

```ts
// src/shared/protocol/ids.ts
export type ProtocolId = 'openai.responses' | 'openai.chat' | 'anthropic.messages'

// src/shared/protocol/ir.ts —— 协议无关中间表示
export interface IrRequest {
  model: string
  system: string[] // instructions / system 消息，合并前保持有序
  messages: IrMessage[]
  tools: IrTool[]
  toolChoice: IrToolChoice
  sampling: { temperature?: number; topP?: number; maxOutputTokens?: number; stop?: string[] }
  reasoning?: { enabled: boolean; effort?: EffortLevel }
  stream: boolean
  /** 原始请求体逐字保留；同协议直通时优先用它，不走 encode 重建 */
  vendor: { protocol: ProtocolId; body: unknown }
}

export type IrRole = 'system' | 'user' | 'assistant' | 'tool'
export interface IrMessage {
  role: IrRole
  blocks: IrBlock[]
}

export type IrBlock =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mediaType: string; data: string } // base64 或 url
  | { kind: 'file'; mediaType: string; data: string; filename?: string }
  | { kind: 'reasoning'; text: string; opaque?: IrOpaque }
  | { kind: 'tool_call'; callId: string; name: string; argumentsJson: string; opaque?: IrOpaque }
  | { kind: 'tool_result'; callId: string; content: IrBlock[]; isError: boolean }

/** 目标协议表达不了、但必须原样带回源协议的载荷 */
export interface IrOpaque {
  protocol: ProtocolId
  payload: unknown
}

// 流式：所有协议归一到这一组事件
export type IrStreamEvent =
  | { type: 'start'; id: string; model: string }
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_start'; index: number; callId: string; name: string }
  | { type: 'tool_call_args_delta'; index: number; delta: string }
  | { type: 'tool_call_end'; index: number }
  | { type: 'usage'; usage: IrUsage }
  | { type: 'end'; stopReason: IrStopReason }
  | { type: 'error'; message: string; kind: string }
```

```ts
// src/shared/protocol/codec.ts
export interface ProtocolCodec {
  readonly id: ProtocolId

  /** ── 客户端侧：catmax 收到的请求 / 要回给客户端的字节 ── */
  decodeRequest(body: unknown): IrRequest
  createResponseEncoder(ctx: EncodeContext): ResponseEncoder

  /** ── 上游侧：发给上游的请求 / 解析上游的字节 ── */
  encodeRequest(ir: IrRequest, caps: UpstreamCapabilities): unknown
  createStreamDecoder(): StreamDecoder
  decodeResponse(body: unknown): IrStreamEvent[] // 非流式归一成同一组事件

  /** 端点路径与鉴权头 */
  upstreamPath(kind: 'chat'): string
  authHeaders(credential: UpstreamCredential): Record<string, string>
}

/** 有状态：负责补 output_index / item_id / added-done 配对 */
export interface ResponseEncoder {
  push(event: IrStreamEvent): Uint8Array[]
  /** 上游流意外中断时合成终态，保证客户端一定收到一个终止事件 */
  finish(reason: 'completed' | 'truncated' | 'error'): Uint8Array[]
}

export interface StreamDecoder {
  push(chunk: Uint8Array): IrStreamEvent[]
  finish(): IrStreamEvent[]
}
```

**几个刻意的设计点**：

- `ResponseEncoder` / `StreamDecoder` 都是**有状态对象**而不是纯函数——Responses 的 added/done 配对、Chat 的 tool_call index 累积、`<think>` 的跨分片检测，本质都需要状态。
- `finish()` 是硬性契约：**无论上游怎么断，客户端必须收到恰好一个终止事件**。这和 `PerTurnCoordinator` 的"exactly-one terminal event"是同一条不变量，风格一致。
- `UpstreamCapabilities` 承载 §3.7 的各家怪癖（`thinkingParam`、`effortValueMode`、`allowPromptCacheKey`、`systemMustBeFirst`、`toolNameMaxLen`…），是**数据不是分支**。
- 同协议直通走 `vendor.body`，转换器完全不参与——直通路径的保真度必须是 100%。

### 6.3 目录结构

```
src/shared/protocol/
  ids.ts                    ProtocolId 联合
  ir.ts                     IR 类型（纯类型 + 少量纯函数，Vue-free / node-free）
  codec.ts                  ProtocolCodec 等接口
  capabilities.ts           UpstreamCapabilities 与内置 preset

src/main/protocol/
  registry.ts               codec 注册表 + 直接转换器逃生舱
  bridge.ts                 组装：decodeRequest → encodeRequest → 转发 → StreamDecoder → ResponseEncoder
  sse.ts                    SSE 分帧/组帧（UTF-8 跨分片安全，参考 cc-switch proxy/sse.rs）
  server.ts                 本地 HTTP 服务（127.0.0.1 + 一次性 token）
  history-store.ts          previous_response_id 补全缓存（§3.1）
  codecs/
    openai-responses.ts
    openai-chat.ts
    anthropic-messages.ts   ← 第三期才写

src/main/service/
  codex-bridge-config.ts    往 config.toml 增写 [model_providers.catmax-bridge]（复用现有备份/原子写）
```

### 6.4 扩展性验证：加 Anthropic 上游要动什么

| 文件                                         | 改动                                                      |
| -------------------------------------------- | --------------------------------------------------------- |
| `shared/protocol/ids.ts`                     | 加一个字面量                                              |
| `main/protocol/codecs/anthropic-messages.ts` | **新增**（唯一的实质工作量）                              |
| `main/protocol/registry.ts`                  | 加一行注册                                                |
| 其它                                         | **零改动** —— `openai-responses.ts` 的 encoder 一行不用动 |

加完之后同时获得：Responses↔Anthropic、Chat↔Anthropic 两个方向，以及 claude 后端未来接 Chat/Responses 上游的能力。这就是选 IR 的理由。

---

## 7. 风险与分期

### 已知风险

1. **本地 HTTP 服务是新的攻击面**。必须：只绑 `127.0.0.1`、端口随机、一次性 token 校验、拒绝非 codex 来源的路径、不落盘任何请求体日志（里面全是用户代码）。
2. **改用户的 `config.toml`**。只增不改、切换只动 `model_provider` 一行、退出时恢复；复用已有的备份+原子写。
3. **凭证流向**。转换桥必须持有上游 key 才能转发，和 "catmax 不存凭证" 的原则贴着走：只在内存中从用户自己的 codex 配置读取，不写进 catmax 任何存储。**这一条要你明确确认后再动手。**
4. **保真度是长期维护成本**。cc-switch 那 4300 行里绝大部分是各家上游的怪癖修补，我们会重走一遍这条路。建议第一期只保证"OpenAI 兼容度高的上游 + 主流思考型模型"能跑通，怪癖按用户反馈增量补。
5. **codex 版本漂移**。codex 每几个版本就往 Responses 请求里加新 item 类型（`tool_search_call` 就是近期加的）。转换器对未知 item 类型必须**降级而不是报错**。

### 建议分期

| 期  | 内容                                                                                      | 状态                |
| --- | ----------------------------------------------------------------------------------------- | ------------------- |
| 1   | 本地 HTTP 桥（`protocol/server.ts`）+ codex spawn 参数接管（`-c` 覆盖，不改 config.toml） | ✅ 已实现           |
| 2   | IR + `openai-responses` / `anthropic-messages` 两个 codec + 流式状态机 + 设置界面         | ✅ 已实现           |
| 3   | 上游能力配置（DeepSeek 预设：无图片 / 忽略 budget）+ 连通性自检                           | ✅ 已实现           |
| 4   | `openai.chat` codec（Chat Completions 上游）+ `previous_response_id` 补历史缓存           | ⬜ 未实现，按需再做 |

**实际实现顺序和原计划不同**：原计划先做 Chat codec、Anthropic 放最后。调研后改成先做 Anthropic——见 §2 的结论，Responses↔Anthropic 结构同构、代码量约为 Chat 路径的 2/3，且用户的上游（DeepSeek）两个协议都支持。第 1 期也没有单独做"纯直通"，因为直通对 Anthropic 上游没有意义（codex 发的是 Responses，上游只收 Anthropic），转换本身就是最小可用单元。

第 1 期是纯直通，看起来"没用"，但它把最难验证的一块（通道 + 配置接管 + 鉴权 + SSE 转发）单独隔离出来，任何问题都能确定不是转换逻辑的锅。强烈建议不要跳。

---

## 8. 待确认的决策点

1. **凭证**：上游 key 只从用户的 `~/.codex/config.toml` 内存读取、catmax 不落盘 —— 确认这个边界？
2. **配置接管方式**：往 `~/.codex/config.toml` 增写一个 `[model_providers.catmax-bridge]`（推荐），还是别的方式？
3. **第一期范围**：按 §7 从"纯直通桥"开始，还是一次性做到能跑 Chat 上游？

---

## 附：外部资料

- [Deprecating `chat/completions` support in Codex — openai/codex discussion #7782](https://github.com/openai/codex/discussions/7782)
- [Codex Config Reference（`wire_api` 条目）](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Codex Advanced Configuration（`model_providers`）](https://learn.chatgpt.com/docs/config-file/config-advanced)
- [openai/codex#9679 — `item not found in turn state` when using `wire_api = "chat"`](https://github.com/openai/codex/issues/9679)
- [janhq/jan#7413 — 第三方工具收到 codex 的 chat 弃用警告](https://github.com/janhq/jan/issues/7413)
