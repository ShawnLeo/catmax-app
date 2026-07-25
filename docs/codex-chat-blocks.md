# Codex Chat Block 展示设计

本文只描述 Codex，不约束 Claude 或其他 backend。

## 1. 数据依据

Codex App Server 是富客户端的正式集成接口，提供历史会话、审批和流式 agent 事件。
客户端应以 `item/*` 作为 turn item 的事实来源，并以 `item/completed` 的最终 item
作为权威状态：

- 官方协议：[Codex App Server](https://developers.openai.com/codex/app-server/)
- 本机协议：`codex app-server generate-ts --experimental --out <dir>`

当前协议中，展示相关数据包括：

- `Turn.durationMs`、`startedAt`、`completedAt`
- `ThreadItem.userMessage.content[]`: `text | image | localImage | skill | mention`
- `agentMessage.phase`: `commentary | final_answer`
- `commandExecution.commandActions`: `read | listFiles | search | unknown`
- `commandExecution.durationMs`、`aggregatedOutput`
- `fileChange.changes[]`: `path`、`kind`、`diff`
- `item/commandExecution/outputDelta`
- `item/fileChange/patchUpdated`
- `turn/diff/updated`

因此 renderer 不应通过 `sed`、`rg`、`find` 等命令字符串猜测“读取/搜索”语义。

## 2. 用户消息

Codex 用户消息有自己的 `CodexUserMessage`，不经过 Claude 或通用 `MessageItem`。当前 App
Server 生成类型需要兼容以下输入：

| `UserInput.type` | 关键字段                  | 展示                                               |
| ---------------- | ------------------------- | -------------------------------------------------- |
| `text`           | `text`, `text_elements[]` | 右对齐用户气泡；标注字段可缺省，不把它序列化到正文 |
| `image`          | `url`, `detail?`          | 气泡上方 80×80 缩略图，支持 HTTPS 和 data URL      |
| `localImage`     | `path`, `detail?`         | 通过主进程文件预览读取缩略图，点击进入文件预览     |
| `skill`          | `name`, `path`            | 气泡上方 skill 标签                                |
| `mention`        | `name`, `path`            | 气泡上方文件/资源提及标签                          |

模型的 `inputModalities` 决定当前模型是否接受图片；旧 App Server 没有返回该字段时，官方
建议按 `text + image` 处理。UI 展示历史时仍应容忍全部输入类型，不能因为当前模型能力变化
而丢弃旧消息。

### 2.1 Codex Desktop 历史兼容

Codex Desktop 的本地 rollout 可能把真实提问包装成一个文本 input：

```text
# Files mentioned by the user:

## screenshot.png: /tmp/screenshot.png

## My request for Codex:
真实提问
```

图片还可能表现为相邻的 `input_text(<image ...>) + input_image + input_text(</image>)`。
这不是公开 App Server 的稳定模型，但本地导入必须兼容：

1. 仅在同时出现完整 `Files mentioned` 和 `My request for Codex` 标记、且包装位于文本开头
   时拆包，避免误删用户自己写的 Markdown。
2. 气泡只显示 `My request for Codex` 后面的真实提问。
3. 文件清单恢复为 `codex_user_input`；图片路径和相邻 data URL 按 path 去重合并。
4. 非图片文件显示文件标签；无正文的纯附件消息仍保留。
5. 旧桥接层的 `input_text` / `input_image.image_url` 也接受，但新代码不主动产生这种私有
   形态。

## 3. Block 模型

Codex 使用两个过程类 block，并由 Codex 自己的 conversation renderer 按 turn 组合：

1. `codex_user_input`
   - 仅属于 user message，承载图片、文件、skill 和 mention。
   - 附件在气泡上方独立布局，不把路径包装文本塞进气泡。
2. `reasoning`
   - 提供“已处理 2m 39s”顶栏的耗时，不直接渲染为独立消息。
   - 顶栏控制整个过程区，不只控制 reasoning 文本。
   - 历史优先使用 `Turn.durationMs`。
3. `codex_activity`
   - 包含一组连续的读取、搜索、命令、文件编辑、MCP、Web、图片或协作活动。
   - 标题按活动类型生成，例如“编辑了文件读取了文件运行了多个命令”。
   - 实时默认展开，按 item id 原位更新，不重复追加。

`agentMessage.phase` 决定文本位置：`commentary` 放进过程区并切断相邻 activity 的聚合，
`final_answer` 永远放在折叠区外。老历史缺少 phase 时，仅把最后一段文本作为最终回答。

Codex conversation renderer 不经过通用 `MessageItem`，因此不会继承 Claude 风格的圆点竖线、
消息间距或 `ToolCallCard`。历史 turn 默认收起过程区；实时 turn 自动展开并保留用户当前
选择。

## 4. 历史投影规则

`thread/read(includeTurns: true)` 返回 turn 和完整 items：

1. `reasoning` 转为 `reasoning` block，写入 `durationMs`、`completedLabel: 已处理`。
2. `commandExecution` 按 `commandActions` 拆成可读活动：
   - `read` → “已读取 file”
   - `listFiles` → “已列出文件 path”
   - `search` → “已搜索 query”
   - `unknown` → “已运行 command”
3. `fileChange` 的每个 change 独立显示“已创建/已编辑/已删除 file +N -M”。
4. 相邻活动跨 item/message 合并为一个 `codex_activity` block。
5. `agentMessage` 保持原始顺序；commentary 会切断活动聚合。
6. 文件编辑在最终回答下方生成 Codex 变更摘要卡片；“审核”打开 Git 面板。

历史 turn 的整个过程区默认折叠，最终回答和变更摘要卡片保持可见。

## 5. 实时投影规则

- `item/started`：创建 running activity。
- `item/commandExecution/outputDelta`：追加到已有命令 activity。
- `item/fileChange/patchUpdated`：用最新 changes 覆盖对应编辑 activity，并重新计算
  `+N/-M`。
- `turn/diff/updated`：保存整轮最新 unified diff 及总增删统计。
- `item/completed`：用最终 item 覆盖 running activity；这是权威完成态。
- 相邻 activity 自动聚合；中间出现 text/reasoning 时开启新活动区段。

实时 block 不自动折叠，避免用户看不到正在变化的文件统计。完成后保持当前展开状态；
重新加载为历史会话时才默认折叠。

## 6. Diff 统计

增删统计从 unified diff 逐行计算：

- `+` 且不是 `+++`：addition
- `-` 且不是 `---`：deletion

统计属于展示派生数据，原始 `diff` 始终保留。文件移动使用 `kind.move_path` 作为展示目标，
点击文件名仍使用原始路径交给文件预览解析器。

## 7. 降级策略

- 老版本没有 `commandActions`：按普通 command 展示。
- 没有 `durationMs`：不显示耗时，不猜测。
- 未知 user input：忽略该 input，保留同一消息中已识别的正文和附件。
- 未知 item：继续走现有 fallback，不阻塞整个会话。
- 未知 `kind`：按“编辑”或普通工具显示，并保留原始 detail。

## 8. 本地 Codex rollout 边界

Codex Desktop 可能在私有 rollout JSONL 中写入原始 `custom_tool_call` 等记录。这些记录不属于
公开的 App Server `ThreadItem` 契约，也不保证出现在 `thread/read` 中。因此主 adapter
不直接解析这一私有格式：通过 App Server 接入的会话使用稳定的 `commandExecution`、
`fileChange` 等 item；若以后需要高保真导入 rollout，应作为独立 backend 插件实现，并配置
版本兼容测试。
