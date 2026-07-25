# 主聊天区会话展示重构方案：Content Block 架构

- **状态**：Draft（待用户 review）
- **日期**：2026-07-25
- **范围**：主聊天区会话消息的渲染架构、共享契约、backend 适配层
- **目标 backend**：claude、codex（已完成），pi agent、grok build（规划中）

---

## 1. 背景与动机

### 1.1 现状评估

当前架构采用 **adapter + 归一化契约** 模式，协议层严格区分，展示层通过 `NormalizedMessage`（`src/shared/backend/types.ts:386`）统一。经全量排查：

- 渲染组件（`MessageItem.vue`、`ToolCallCard.vue` 等）**完全看不到 backend 字段**，`src/renderer/src/components/chat/` 下 **0 处** `if backend === 'codex'` 条件渲染
- `NormalizedMessage` 是 UI 唯一契约，无 discriminated union、无 backend 分支
- 两个 backend 各自的 mapping 层把原始协议翻译成同一套 `TurnEvent` / `NormalizedMessage`

**结论**：当前展示**不是**"混在一起只适配 Claude"，而是"协议归一化做得相当干净"。

### 1.2 真正的痛点：契约的 Claude-centric 倾向

虽然渲染层没崩，但**契约设计本身是 Claude-centric 的**，对未来扩展会越来越别扭。三类隐式耦合：

| # | 问题 | 证据 |
|---|---|---|
| 1 | 归一化类型是"大杂烩"：claude 的 `task` / `control` / `web` / `taskStats` 概念被硬塞进共享契约 | `ToolCallInfo.edit/control/web/task` 全 optional，但实际只有 claude mapping 填 |
| 2 | 没有"能力声明"机制：UI 不知道某 backend 是否支持子 agent / compact / plan mode | `session/handlers.ts:411` `if backend !== 'claude' return []` 是隐式判断 |
| 3 | 没有"插件式 UI 扩展点"：新 backend 的独特展示需求无干净注入点 | 只能继续往 `ToolCallCard.vue` switch 里塞分支 |

### 1.3 为什么现在能"统一"

因为 **codex 恰好是 claude 的功能子集**。一旦 pi agent / grok build 带来 claude 没有的新概念（如 grok 的 build 流程可视化、pi 的 reasoning 树），现有契约就装不下了。

---

## 2. 设计目标（已与用户确认）

| 目标 | 说明 |
|---|---|
| **G1 扩展性** | 新 backend 接入零侵入共享契约，只做"声明 + 注册" |
| **G2 清理 Claude 污染** | 把 claude-only 概念从共享契约抽离，共享层回归最小公共集 |
| **G3 差异化展示** | 不同 backend 在主聊天区可以有独特区块（不只是换图标） |
| **G4 补齐 codex** | 让 codex 能声明自己的增强 block，补齐相对 claude 缺失的展示特性 |

### 2.1 关键设计决定（已与用户确认）

- **架构方向**：方案 B —— Content Block 枚举 + 渲染注册表 + 能力声明
- **注册机制**：**动态加载**（`defineAsyncComponent` + 路由表），新 backend 像插件一样挂载
- **Text/Reasoning 建模**：**拆成两个独立 block 类型**（不合并为 variant）

---

## 3. 核心架构

### 3.1 总览

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer (MessageItem.vue)                                 │
│  遍历 message.blocks → 通过 BlockRegistry 解析为异步组件    │
└────────────────────────┬────────────────────────────────────┘
                         │ 查询
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  BlockRegistry (src/renderer/.../blocks/registry.ts)        │
│  Map<blockType, AsyncComponentLoader>                       │
│  • getBlockRenderer(type) → AsyncComponentWrapper          │
│  • registerBlock(type, loader, fallback?)                  │
└────────────────────────┬────────────────────────────────────┘
                         │ 注册（app 启动时各 backend 插件入口）
                         ▼
┌──────────────────┬──────────────────┬──────────────────┐
│ BaseBlocks       │ ClaudeBlocks     │ CodexBlocks      │
│ (text/reasoning/ │ (task/plan/web/  │ (shell_log/      │
│  tool/context)   │  compact)        │  apply_patch)    │
└──────────────────┴──────────────────┴──────────────────┘

Main 进程侧：
┌─────────────────────────────────────────────────────────────┐
│  mapping.ts (各 backend)                                    │
│  原始协议 → ContentBlock[]（输出统一形态，内容可差异化）   │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 三层职责

1. **Shared 契约层**（`src/shared/backend/`）：定义 `ContentBlock` 联合类型 + 基础 block + `BackendCapabilities`。是 main 与 renderer 的唯一边界。
2. **Main 适配层**（`src/main/backend/<backend>/`）：把原始协议翻译成 `ContentBlock[]`。这里是 backend 差异化的"产出端"。
3. **Renderer 注册层**（`src/renderer/.../blocks/`）：声明式把 `blockType → 异步组件` 绑定。这里是 backend 差异化的"展示端"。

---

## 4. 数据契约设计

### 4.1 ContentBlock 联合类型

```ts
// src/shared/backend/blocks.ts

/** 所有 block 的公共字段 */
export interface BaseBlock {
  /** 块内全局唯一 id，用于 v-for key 和流式更新定位 */
  id: string
  /** 该 block 的创建时间戳，用于排序与调试 */
  createdAt: number
}

// ────────────────── 基础 block（所有 backend 共享）──────────────────

/** 普通文本/markdown 内容（用户输入、assistant 正文） */
export interface TextBlock extends BaseBlock {
  type: 'text'
  text: string
  /** 流式状态：streaming 时 UI 显示光标 */
  streaming?: boolean
}

/** 推理过程（claude thinking / codex reasoning summary） */
export interface ReasoningBlock extends BaseBlock {
  type: 'reasoning'
  text: string
  streaming?: boolean
  /** 折叠状态初始值，由 mapping 层根据 backend 习惯决定 */
  defaultCollapsed?: boolean
}

/** 工具调用（统一入口，具体形态由 payload 区分） */
export interface ToolCallBlock extends BaseBlock {
  type: 'tool_call'
  info: ToolCallInfo
  status: 'running' | 'completed' | 'error' | 'cancelled'
  output?: ToolCallOutput
}

/** 上下文附件（IDE 选中、文件引用等） */
export interface ContextBlock extends BaseBlock {
  type: 'context'
  items: ContextItem[]
}

// ────────────────── Claude 专属 block ──────────────────

/** 子 agent（Task）完成统计 */
export interface TaskSummaryBlock extends BaseBlock {
  type: 'task_summary'
  agentId: string
  stats: { totalCalls: number; durationMs: number; toolCount: number }
}

/** Plan mode 进入/退出标记 */
export interface PlanModeBlock extends BaseBlock {
  type: 'plan_mode'
  action: 'enter' | 'exit'
}

/** Web 工具活动（WebSearch / WebFetch）摘要 */
export interface WebActivityBlock extends BaseBlock {
  type: 'web_activity'
  action: 'search' | 'fetch'
  query?: string
  url?: string
  resultCount?: number
}

/** /compact 历史压缩分隔符 */
export interface CompactDividerBlock extends BaseBlock {
  type: 'compact_divider'
  /** 压缩前的消息数等元信息，用于展示"已压缩 N 条" */
  summary?: { compressedCount: number; compactedAt: number }
}

// ────────────────── Codex 专属 block（补齐 G4）──────────────────

/** 增强版 shell 命令日志（含完整 stdout/stderr 折叠） */
export interface ShellLogBlock extends BaseBlock {
  type: 'shell_log'
  command: string
  stdout?: string
  stderr?: string
  exitCode?: number
  durationMs?: number
}

/** apply_patch 操作的结构化展示 */
export interface ApplyPatchBlock extends BaseBlock {
  type: 'apply_patch'
  patch: UnifiedDiff
  filesAffected: string[]
}

// ────────────────── 联合类型 ──────────────────

export type ContentBlock =
  | TextBlock
  | ReasoningBlock
  | ToolCallBlock
  | ContextBlock
  | TaskSummaryBlock
  | PlanModeBlock
  | WebActivityBlock
  | CompactDividerBlock
  | ShellLogBlock
  | ApplyPatchBlock
// 未来扩展（pi/grok）在此追加，或在独立 backend 目录的 types.ts 里
// 用 module augmentation 扩展 ContentBlock

export type BlockType = ContentBlock['type']
```

### 4.2 NormalizedMessage 瘦身

```ts
// src/shared/backend/types.ts（改造后）

export interface NormalizedMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  turnId: string
  createdAt: number
  /** 替代原来的 textBlocks + toolBlocks + contextBlocks 三件套 */
  blocks: ContentBlock[]
}

// 删除字段：
// - textBlocks    → 由 blocks 里的 TextBlock / ReasoningBlock 替代
// - toolBlocks    → 由 blocks 里的 ToolCallBlock 替代
// - contextBlocks → 由 blocks 里的 ContextBlock 替代
// - taskStats     → 由 blocks 里的 TaskSummaryBlock 替代（claude-only）
```

**关键原则**：`NormalizedMessage` 不再持有任何 backend-specific 字段。所有差异都体现在 `blocks` 数组的内容里。

### 4.3 BackendCapabilities 能力声明

```ts
// src/shared/backend/capabilities.ts

export interface BackendCapabilities {
  /** 是否支持子 agent（决定 TaskCard 是否显示"展开子会话"） */
  subAgents: boolean
  /** 是否支持 /compact 命令 */
  compact: boolean
  /** 是否有 plan mode 概念 */
  planMode: boolean
  /** 是否有 web 工具 */
  webTools: boolean
  /** 权限批准模式：codex 只有 default，claude 多一个"本会话都允许" */
  approvalModes: ('default' | 'always_allow_session')[]
  /** 该 backend 可能产出的 block 类型集合（用于校验与调试） */
  blockTypes: BlockType[]
}

export const CAPABILITIES: Record<BackendId, BackendCapabilities> = {
  claude: {
    subAgents: true,
    compact: true,
    planMode: true,
    webTools: true,
    approvalModes: ['default', 'always_allow_session'],
    blockTypes: ['text', 'reasoning', 'tool_call', 'context',
                 'task_summary', 'plan_mode', 'web_activity', 'compact_divider'],
  },
  codex: {
    subAgents: false,
    compact: false,
    planMode: false,
    webTools: false,
    approvalModes: ['default'],
    blockTypes: ['text', 'reasoning', 'tool_call', 'context',
                 'shell_log', 'apply_patch'],
  },
}
```

UI 用 capability 决定显隐，不再 hardcode backend 名。例如 `PermissionPanel.vue` 现在的 `isClaude` 判断改为读 `CAPABILITIES[backend].approvalModes.includes('always_allow_session')`。

---

## 5. 渲染注册表设计（动态加载）

### 5.1 注册表 API

```ts
// src/renderer/src/components/chat/blocks/registry.ts
import {
  defineAsyncComponent,
  defineComponent,
  h,
  type AsyncComponentLoader,
  type Component,
} from 'vue'
import type { BlockType } from '@shared/backend/blocks'

type FallbackStrategy = 'hide' | 'show-raw'

interface BlockRegistration {
  loader: AsyncComponentLoader<Component>
  /** 未注册或加载失败时的兜底策略，默认 show-raw */
  fallback: FallbackStrategy
}

const registry = new Map<BlockType, BlockRegistration>()

/** 未注册 block 的全局默认兜底策略（可被单次注册覆盖） */
const DEFAULT_FALLBACK: FallbackStrategy = 'show-raw'

/** 注册一个 block 类型的异步组件 */
export function registerBlock(
  type: BlockType,
  loader: AsyncComponentLoader<Component>,
  fallback: FallbackStrategy = DEFAULT_FALLBACK,
): void {
  if (registry.has(type)) {
    console.warn(`[BlockRegistry] block type "${type}" 已注册，覆盖中`)
  }
  registry.set(type, { loader, fallback })
}

/** 取一个 block 类型的渲染组件（带 loading/error/fallback 包装） */
export function getBlockRenderer(type: BlockType): Component {
  const reg = registry.get(type)
  // 未注册的 block：按全局默认策略兜底
  if (!reg) {
    return DEFAULT_FALLBACK === 'hide' ? NullBlock : FallbackBlock
  }
  // 用 defineAsyncComponent 包装，统一处理 loading/error
  return defineAsyncComponent({
    loader: reg.loader,
    loadingComponent: BlockLoading,
    // 加载失败时按该 block 注册时的 fallback 策略处理
    errorComponent: reg.fallback === 'hide' ? NullBlock : BlockError,
    delay: 0,           // 立即显示 loading，避免闪烁
    timeout: 10000,     // 10s 超时显示 error
  })
}

export function isBlockRegistered(type: BlockType): boolean {
  return registry.has(type)
}
```

### 5.2 兜底组件

```vue
<!-- BlockLoading.vue：加载中骨架 -->
<template>
  <div class="block-loading">…</div>
</template>

<!-- BlockError.vue：组件加载失败 -->
<script setup lang="ts">
import type { BaseBlock } from '@shared/backend/blocks'
const props = defineProps<{ block: BaseBlock }>()
</script>
<template>
  <div class="block-error">[区块渲染失败: {{ props.block.type }}]</div>
</template>

<!-- FallbackBlock.vue：未知 block 类型兜底（显示原始 JSON，便于调试） -->
<script setup lang="ts">
import type { BaseBlock } from '@shared/backend/blocks'
const props = defineProps<{ block: BaseBlock }>()
</script>
<template>
  <pre class="block-fallback">{{ JSON.stringify(props.block, null, 2) }}</pre>
</template>
```

### 5.3 各 backend 的注册入口

```ts
// src/renderer/src/components/chat/blocks/base/index.ts
// —— 基础 block（所有 backend 共享，但每个 backend 独立注册自己支持的集合）——
import TextBlockView from './TextBlockView.vue'
import ReasoningBlockView from './ReasoningBlockView.vue'
import ToolCallBlockView from './ToolCallBlockView.vue'
import ContextBlockView from './ContextBlockView.vue'
import { registerBlock } from '../registry'

export function registerBaseBlocks(): void {
  registerBlock('text', () => TextBlockView)
  registerBlock('reasoning', () => ReasoningBlockView)
  registerBlock('tool_call', () => ToolCallBlockView)
  registerBlock('context', () => ContextBlockView)
}
```

```ts
// src/renderer/src/components/chat/blocks/claude/index.ts
import { registerBlock } from '../registry'
import TaskSummaryBlockView from './TaskSummaryBlockView.vue'
import PlanModeBlockView from './PlanModeBlockView.vue'
import WebActivityBlockView from './WebActivityBlockView.vue'
import CompactDividerBlockView from './CompactDividerBlockView.vue'

/** Claude 插件注册入口——由 app bootstrap 调用 */
export function registerClaudeBlocks(): void {
  registerBlock('task_summary', () => TaskSummaryBlockView)
  registerBlock('plan_mode', () => PlanModeBlockView)
  registerBlock('web_activity', () => WebActivityBlockView)
  registerBlock('compact_divider', () => CompactDividerBlockView)
}
```

```ts
// src/renderer/src/components/chat/blocks/codex/index.ts
import { registerBlock } from '../registry'
import ShellLogBlockView from './ShellLogBlockView.vue'
import ApplyPatchBlockView from './ApplyPatchBlockView.vue'

/** Codex 插件注册入口 */
export function registerCodexBlocks(): void {
  registerBlock('shell_log', () => ShellLogBlockView)
  registerBlock('apply_patch', () => ApplyPatchBlockView)
}
```

### 5.4 App bootstrap 集中注册

```ts
// src/renderer/src/main.ts（或专门的 blocks-bootstrap.ts）
import { registerBaseBlocks } from '@/components/chat/blocks/base'
import { registerClaudeBlocks } from '@/components/chat/blocks/claude'
import { registerCodexBlocks } from '@/components/chat/blocks/codex'

// app 启动时一次性注册所有 backend 的 block 组件
registerBaseBlocks()
registerClaudeBlocks()
registerCodexBlocks()
// 未来：registerPiBlocks()、registerGrokBlocks()
```

### 5.5 MessageItem.vue 收敛

```vue
<!-- src/renderer/src/components/chat/MessageItem.vue（改造后） -->
<script setup lang="ts">
import { getBlockRenderer } from './blocks/registry'
import type { NormalizedMessage } from '@shared/backend/types'

const props = defineProps<{
  message: NormalizedMessage
  cwd?: string
}>()
</script>

<template>
  <div class="message" :class="`message--${message.role}`">
    <component
      v-for="block in message.blocks"
      :key="block.id"
      :is="getBlockRenderer(block.type)"
      :block="block"
      :cwd="cwd"
      :message-role="message.role"
    />
  </div>
</template>
```

**核心收益**：`MessageItem.vue` 从 ~290 行收敛到 ~20 行，且对任何新 block 类型零侵入。

---

## 6. Main 进程适配层改造

### 6.1 mapping 层职责变化

各 backend 的 `mapping.ts` 不再输出老的 `textBlocks/toolBlocks/contextBlocks`，而是直接输出 `ContentBlock[]`。

```ts
// src/main/backend/claude/mapping.ts（示意）
import type { ContentBlock, TextBlock, ToolCallBlock } from '@shared/backend/blocks'

/** Claude SDK message → ContentBlock[] */
export function claudeMessageToBlocks(msg: ClaudeSdkMessage): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const block of msg.content) {
    switch (block.type) {
      case 'text':
        blocks.push({ id: genId(), type: 'text', text: block.text, createdAt: Date.now() })
        break
      case 'thinking':
        blocks.push({ id: genId(), type: 'reasoning', text: block.thinking, createdAt: Date.now() })
        break
      case 'tool_use':
        blocks.push({ id: genId(), type: 'tool_call', info: toolUseToInfo(block), status: 'running', createdAt: Date.now() })
        break
      case 'tool_result':
        // 合并到对应的 tool_call block 的 output
        break
      // ...其他 case
    }
  }
  return blocks
}
```

### 6.2 TurnEvent 适配

**事件类型定义保持不变**：`TurnEvent` 联合（`src/shared/backend/types.ts:330`）的 `text_delta` / `reasoning_delta` / `tool_call_started` 等已经是 backend-agnostic 的，无需改造。

**变化的只是 store 的数据结构**：renderer 的 `applyEvent`（`src/renderer/src/stores/message.ts:181`）现在操作的是 `message.textBlocks / toolBlocks / contextBlocks`，Phase 4 后改为操作统一的 `message.blocks` 数组。具体说：

- `text_delta` 事件 → 找到/创建 `blocks` 里 `type: 'text'` 的 block，追加 `text`
- `reasoning_delta` 事件 → 找到/创建 `blocks` 里 `type: 'reasoning'` 的 block，追加 `text`
- `tool_call_started` 事件 → 往 `blocks` 里 push 一个 `type: 'tool_call'` 的 block
- `tool_call_completed` 事件 → 翻转对应 `tool_call` block 的 `status`，填 `output`

**定位策略**：事件用 `itemId` 定位目标 block。mapping 层保证 `event.itemId === block.id`（见开放问题 3）。

### 6.3 能力声明的使用

`session/handlers.ts:411` 的 `if backend !== 'claude' return []` 改为：

```ts
import { CAPABILITIES } from '@shared/backend/capabilities'

export const readSubagentHistory = async (args: { backend: BackendId; agentId: string; cwd: string }) => {
  if (!CAPABILITIES[args.backend].subAgents) return []
  return readSubagentHistoryFromJsonl(args.agentId, args.cwd)
}
```

`PermissionPanel.vue:109` 的 `isClaude` 改为读 `CAPABILITIES[currentBackend].approvalModes.includes('always_allow_session')`。

---

## 7. 对四个目标的覆盖验证

| 目标 | 落地方式 | 验收点 |
|---|---|---|
| **G1 扩展性** | 新 backend 三步：①声明 block 类型 ②注册 block 组件 ③填 `CAPABILITIES` | 接入 pi agent 时 `NormalizedMessage`/`MessageItem` 零改动 |
| **G2 清理污染** | `task/control/web/taskStats` 从 `NormalizedMessage` 抽出为独立 block | `NormalizedMessage` 只剩 `id/role/turnId/createdAt/blocks` |
| **G3 差异化** | 每个 backend 注册独特 block（grok `BuildStepBlock`、pi `ReasoningTreeBlock`） | 主聊天区能渲染出 backend 独有区块，且未注册时优雅 fallback |
| **G4 补齐 codex** | codex 声明 `ShellLogBlock`（增强 shell 日志）、`ApplyPatchBlock` | codex 会话展示不再只是"claude 子集"，有自己增强展示 |

---

## 8. 迁移路径（分 5 阶段，每阶段可独立 ship）

### Phase 1：基础设施（1 周）

**目标**：搭好骨架，但不动现有流量。

- [ ] 新建 `src/shared/backend/blocks.ts`，定义 `ContentBlock` 联合 + 基础 block 类型
- [ ] 新建 `src/shared/backend/capabilities.ts`，定义 `BackendCapabilities` + `CAPABILITIES`
- [ ] 新建 `src/renderer/.../blocks/registry.ts` + 兜底组件（`FallbackBlock`/`BlockLoading`/`BlockError`）
- [ ] 在 `main.ts` 加 `registerBaseBlocks()` 调用（但 `MessageItem` 还没用新结构）

**验收**：类型检查通过；注册表单测覆盖（注册、查询、覆盖告警、未注册 fallback）。

### Phase 2：Claude 抽离（1.5 周）

**目标**：把 claude-only 概念改造成独立 block，mapping 同步改。

- [ ] 新建 claude block 组件（`TaskSummaryBlockView` 等 4 个），从老的 `TaskCard`/`control/*Card`/`web/WebCard`/`CompactDivider` 迁移逻辑
- [ ] `claude/mapping.ts` + `claude/history-mapping.ts` 输出新的 block 类型（同时保留老字段做过渡）
- [ ] `registerClaudeBlocks()` 注册入口

**验收**：claude 会话在新结构下渲染正确；老的 `TaskCard` 等组件仍可用（过渡期双轨）。

### Phase 3：Codex 迁移 + 补齐（1 周）

**目标**：codex 切到新结构，顺便补齐特有 block。

- [ ] `codex/mapping.ts` + `codex/history-mapping.ts` 输出 `ContentBlock[]`
- [ ] 新增 `ShellLogBlock`（增强 shell 日志，含完整 stdout/stderr 折叠）和 `ApplyPatchBlock`
- [ ] `registerCodexBlocks()` 注册入口

**验收**：codex 会话在新结构下渲染正确；新增 block 可见。

### Phase 4：契约切换（0.5 周）

**目标**：`NormalizedMessage.blocks` 正式上线，删除老字段。

- [ ] `NormalizedMessage` 改为 `blocks: ContentBlock[]`，删除 `textBlocks/toolBlocks/contextBlocks/taskStats`
- [ ] `message.ts` 的 `applyEvent` 改为操作 `blocks` 数组
- [ ] `MessageItem.vue` 改为遍历 `blocks` + 动态组件（~20 行）
- [ ] 删除老组件（`TaskCard` 等）和老的 backend 判断
- [ ] 全量 typecheck + 手动回归 claude/codex

**风险点**：这是破坏性改动，集中在一次提交。靠 TypeScript 兜底——所有引用老字段的地方会编译失败，逐一修复。

### Phase 5：能力声明收尾（0.5 周）

**目标**：用 `CAPABILITIES` 替换所有散落的 backend 判断。

- [ ] `session/handlers.ts:411` 改为读 capability
- [ ] `PermissionPanel.vue:109` 改为读 capability
- [ ] 审计 `message.ts`、其他 renderer 代码，把零散 backend 判断替换为 capability 查询

**验收**：`grep -r "backend === 'claude'" src/renderer/ src/main/ipc/` 只剩明确必要的处（如品牌图标 `BackendIcon.vue`）。

---

## 9. 测试策略

### 9.1 单元测试（Vitest）

| 测试目标 | 测试文件 | 覆盖点 |
|---|---|---|
| `BlockRegistry` | `tests/renderer/blocks/registry.test.ts` | 注册、查询、覆盖告警、未注册 fallback、超时 error |
| `CAPABILITIES` 一致性 | `tests/shared/capabilities.test.ts` | 每个 backend 的 `blockTypes` 与实际 mapping 输出一致 |
| `claudeMessageToBlocks` | `tests/main/backend/claude/mapping.test.ts` | 各种 SDK message → 正确 block 类型 |
| `codexMessageToBlocks` | `tests/main/backend/codex/mapping.test.ts` | codex item → 正确 block，含新的 `shell_log`/`apply_patch` |
| `messageStore.applyEvent` | `tests/renderer/stores/message.test.ts` | TurnEvent 在 `blocks` 数组上的增量更新 |

### 9.2 集成/回归测试

- **历史回放**：用 claude jsonl + codex turns 的真实样本，验证 `getHistory` → 渲染输出无差异
- **流式**：mock TurnEvent 流，验证 `blocks` 增量更新（追加、状态翻转、流式光标）
- **Fallback**：注入一个未注册的 block type，验证 `FallbackBlock` 显示原始 JSON

### 9.3 手动回归清单

每个 Phase 结束后手动验证：

- [ ] claude 会话：文本、thinking、工具调用、Task 子 agent、plan mode、web 工具、/compact 历史全部正常
- [ ] codex 会话：文本、reasoning、工具调用、新增 shell_log、apply_patch 正常
- [ ] 切换 backend 时会话列表与内容正确刷新
- [ ] 权限批准面板文案随 capability 正确变化
- [ ] 未注册 block 的 fallback 不崩

---

## 10. 目录结构（改造后）

```
src/shared/backend/
  blocks.ts                ← 新：ContentBlock 联合 + 基础/扩展 block 类型
  capabilities.ts          ← 新：BackendCapabilities + CAPABILITIES
  types.ts                 ← 瘦身：NormalizedMessage / TurnEvent（删 claude-only 字段）
src/renderer/src/components/chat/
  MessageItem.vue          ← 收敛为遍历 blocks + 动态组件（~20 行）
  blocks/
    registry.ts            ← 新：动态加载注册表
    FallbackBlock.vue      ← 新：未知 block 兜底
    BlockLoading.vue       ← 新：加载中骨架
    BlockError.vue         ← 新：加载失败
    base/                  ← 基础 block（text/reasoning/tool_call/context）
      index.ts
      TextBlockView.vue
      ReasoningBlockView.vue
      ToolCallBlockView.vue   ← 从老 ToolCallCard.vue 迁移
      ContextBlockView.vue
    claude/                ← claude 专属 block
      index.ts
      TaskSummaryBlockView.vue   ← 从 TaskCard.vue 迁移
      PlanModeBlockView.vue
      WebActivityBlockView.vue
      CompactDividerBlockView.vue
    codex/                 ← codex 专属 block
      index.ts
      ShellLogBlockView.vue      ← 新增（补齐）
      ApplyPatchBlockView.vue    ← 新增（补齐）
src/main/backend/
  <backend>/mapping.ts     ← 改造：输出 ContentBlock[]
src/renderer/src/
  blocks-bootstrap.ts      ← 新：集中调用各 registerXxxBlocks()
```

---

## 11. 风险与权衡

| 风险 | 缓解 |
|---|---|
| **动态加载首屏闪烁** | `delay: 0` 立即显示 loading；基础 block 可考虑同步加载（不走 async） |
| **Phase 4 破坏性切换** | 一次性大改，靠 TypeScript 编译错误逐一兜底；切换前确保 Phase 2/3 双轨期充分验证 |
| **注册顺序依赖** | bootstrap 时同步调用注册，避免运行时查询时未注册 |
| **module augmentation 扩展 ContentBlock** | 第三方/未来 backend 若要扩展联合类型，需在 shared 层声明——这是有意约束，保证契约可见 |
| **过度设计风险** | `ShellLogBlock`/`ApplyPatchBlock` 是为补齐 codex 而设计，若实际收益不大可在 Phase 3 评估后裁剪 |

---

## 12. 不在本次范围内（YAGNI）

- **block 之间的拖拽重排**：当前无需求
- **block 级别的权限控制**：权限仍在 turn/message 级
- **block 版本化/迁移**：历史 jsonl 读取时直接映射到当前 block 类型，不做版本号
- **第三方插件市场**：动态加载是为内置 backend 设计，不涉及用户安装的插件
- **block 的 A/B 实验框架**：无需求

---

## 13. 开放问题（需在实现阶段确认）

1. **`ToolCallBlock.info` 的结构**：当前 `ToolCallInfo`（`types.ts:109`）本身仍是大杂烩（`edit/control/web/task` optional）。是否在 Phase 2 同步把它也按 block 拆分？倾向：**不拆**——`ToolCallBlock` 保持统一，差异通过 `info.kind` 区分，避免一次改太多。但需在 Phase 2 评估。

2. **历史 jsonl 兼容**：claude 老会话的 jsonl 里没有新 block 概念，`history-mapping.ts` 需要做兼容映射。是否需要版本探测？倾向：不需要——mapping 函数天然处理"有则映射，无则跳过"。

3. **流式更新定位**：`TurnEvent` 现在用 `itemId` 定位流式追加目标。新结构下 block 也有 `id`，需确认 `itemId === block.id` 的映射关系是否保持。倾向：保持，mapping 层保证一致。

---

## 14. 总结

本方案用 **Content Block 枚举 + 动态加载注册表 + 能力声明** 三件套，把当前 Claude-centric 的归一化契约改造成**最小公共集 + 可扩展差异点**的架构：

- 共享契约只保留 4 个基础 block，所有 backend 差异通过新增 block 类型 + 注册组件实现
- 新 backend 接入是"纯增量"操作（声明类型 + 注册组件 + 填 capability），零侵入共享层
- 每个 backend 可以有自己独特的展示区块，真正实现差异化
- codex 顺便补齐增强展示（`ShellLogBlock`/`ApplyPatchBlock`）
- 分 5 阶段迁移，每阶段可独立 ship，风险可控

最终 `MessageItem.vue` 从 ~290 行收敛到 ~20 行，且对未来 pi agent / grok build 等新 backend 完全开放。
