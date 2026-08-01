# 会话导航侧轨（Session Nav Rail）设计

**Date**: 2026-08-01
**Status**: Approved (pending spec review)
**Reference**: Codex 贴在会话最左侧的横条导航

## 背景与目标

主聊天区（`MessageList`）右侧是长对话，用户希望在最左侧增加一条类似 Codex 的「目录」侧轨：每条用户消息对应一根横条，悬停变亮变长 + 预览该条消息全文，点击滚动定位到对应消息。视觉需同时适配暗色 / 亮色主题。

## 非目标（YAGNI）

- 不做位置映射式 minimap（横条不映射到消息在文档里的实际高度）。
- 不做整个会话的「所有用户消息列表」浮层——tooltip 只显示**当前悬停那条**用户消息的文本。
- 不为 assistant 消息生成横条（横条仅对 user 消息）。
- 不引入虚拟滚动 / 锚点回收算法——会话用户消息数量级（几十条）下 DOM 查询与 IntersectionObserver 完全够用。

## 整体布局

在 `MessageList.vue` 的根层新增 `relative` 包裹层；内部是原滚动容器（保持原有 `overflow-y-auto`、`flex-1`、`min-h-0`、`@scroll` 不变）+ 绝对定位的 `MessageNavRail`。

```
┌─────────────────────────────────────────┐
│ ║══════  ← 第1条 user msg（横条）       │  侧轨 width: ~14px
│ ║                                       │  absolute left-0 top-1/2 -translate-y-1/2
│ ║══════  ← 第2条 user msg              │  垂直居中、均匀分布
│ ║                                       │
│ ║══════  ← 第3条 user msg（激活态，     │  消息正文（原滚动区，max-w 不变）
│ ║         更长更亮）                    │
└─────────────────────────────────────────┘
```

侧轨 z-index 高于消息内容；左侧贴边，宽度仅约 14px，不遮挡正文（正文由 `px-6`/`px-4` 留出内边距，侧轨落在 padding 区域内）。

## 显示条件

三个条件全部满足时才渲染侧轨：

1. 用户消息条数 ≥ 2（`userMessages.length >= 2`）——单轮对话不显示，避免多余。
2. 容器宽度 ≥ 阈值 `MIN_WIDTH_FOR_RAIL = 640px`（与现有 `max-w-3xl` sm 断点对齐——窗口特别窄时让位给正文）。
3. 已有消息内容（沿用 `MessageList` 已有的 `messageStore.messages.length > 0`，由 `ChatView` 的 `v-if` 保证）。

容器宽度由 `MessageList` 根层的 `ResizeObserver` 监听（`MessageList` 已有滚动逻辑但未监听宽度，需新增 ref 跟踪根层宽度）。

## 视觉规格

参考 Codex 贴边横条，加上「灰 → 亮」「激活态更长」的动画效果。

### 三态样式（双主题）

横条有三个独立可叠加的视觉维度：颜色、宽度、高度。状态到样式的映射：

| 状态 | 颜色 | 宽度 | 高度 |
|---|---|---|---|
| 默认 | `--muted-foreground`（灰） | 18px | 3px |
| active（当前滚动位置） | `--foreground`（亮） | 32px | 4px |
| hover（鼠标悬停，优先级最高） | `--foreground`（亮） | 32px | 4px |

**设计意图**：active 和 hover 的最终样式相同（都更亮 + 更长 + 更高），这样视觉一致——用户悬停或滚动到位时看到的是同一个「突出态」。区别仅在触发方式：active 由滚动位置驱动，hover 由鼠标驱动。

**双主题下 `--foreground` 的值**（无需写主题分支）：

| 主题 | `--muted-foreground`（默认态灰） | `--foreground`（active/hover 亮） |
|---|---|---|
| dark | `oklch(60% 0 0)`（中灰） | `oklch(95% 0 0)`（近白） |
| light | `oklch(50% 0 0)`（中灰） | `oklch(20% 0 0)`（近黑） |

满足「夜间灰、激活白；日间灰、激活黑」。圆角统一 `rounded-full`。

**主题适配关键**：默认态用语义 token `--muted-foreground`（灰），激活 / hover 用 `--foreground`（暗色下=白，亮色下=黑）——天然满足「夜间灰、激活白；日间灰、激活黑」，无需写主题分支。

**动画**：
- 宽度变化用 `transition-all duration-150 ease-out`。
- 背景色同样走该过渡，产生「鼠标划过时的动画感」。
- 宽度向右伸长，左侧始终贴边——用 `width` 属性变化而非 `transform: scaleX`，避免脱离开尔文原点（用 transform 会从中心缩放，需要额外 `origin-left` 且容易跟 translate 冲突）。

### hover 与 active 的关系

active 和 hover 落到同一个「突出态」，因此**不存在冲突需要仲裁**：

- 当前 active 的横条，鼠标悬停时仍是突出态（颜色 / 宽度 / 高度都不变）。
- 非 active 的横条，鼠标悬停时**临时**进入突出态（视觉上「亮起来」），鼠标移开后回到默认灰态。
- 滚动改变 activeId 时，新的 active 横条进入突出态，旧的退出。

实现：CSS 类组合——`.rail-item`（默认）+ `.rail-item.active`（突出）+ `.rail-item:hover`（突出）。`:hover` 和 `.active` 写相同的突出样式即可，谁先生效都不影响最终外观，无需 JS 仲裁 hover vs active。

## 激活态逻辑

「激活」= 当前最近一次滚动后，**最靠近视口顶部**的用户消息。

实现：`useMessageAnchors` composable 内部用 `IntersectionObserver`（`root` = 滚动容器，`rootMargin: '0px 0px -60% 0px'`，`threshold: [0, 0.5, 1]`）观察每个 user message 锚点元素。回调时取**最靠上且已进入观测区**的消息作为 activeId。

**Hysteresis（防抖动）**：只有当另一条消息可见度超过当前激活消息达到一定阈值（用 `intersectionRatio` 比较，比如新消息 ratio > 0.5 且大于当前激活的 ratio）时才切换，避免滚动经过边界时来回闪烁。

初始值：侧轨首次渲染时，activeId = 第一条用户消息的 id。

## 交互

### 悬停（hover）

- 横条变长变亮（见三态表）。
- 右侧弹出气泡显示该条用户消息的文本（截断到 ~120 字符 + 省略号）。
- 气泡样式：`bg-popover text-popover-foreground border border-border rounded-md px-2 py-1 shadow-md text-[length:var(--ui-text-d3)]`，位于横条右侧（`absolute left-full ml-2 top-1/2 -translate-y-1/2`）。
- 气泡 `pointer-events-none`，不抢焦点、不影响 hover 计算。
- 用 `group/group-hover` 控制显隐（无需 JS state），与 `MessageItem` 已有的 hover 模式一致。

### 点击（click）

- 调用 `scrollToMessage(id)` → 该锚点 `el.scrollIntoView({ behavior: 'smooth', block: 'start' })`。
- 锚点元素（`MessageItem` 的 `<article>`）加 `scroll-margin-top: 8px`（CSS），让滚动定位后消息与滚动容器顶部留出呼吸空间（避免消息紧贴顶边）。注：`RuntimeConfigBar` 是 `MessageList` 上方的兄弟，不在滚动容器内，所以 `scroll-margin-top` 不影响它。
- 点击后，IntersectionObserver 会自然把 activeId 更新到这条消息（滚动到位后）。

### 键盘可达

- 横条是 `<button>` 元素，天然支持 Tab 聚焦 + Enter / Space 触发点击。
- `aria-label` 设为「跳转到第 N 条消息」或消息预览文本，屏幕阅读器友好。
- 遵循项目惯例（`MessageItem` 的复制按钮、`MessageList` 的回到底部按钮都是 `<button>`）。

## 文件结构（方案 C：composable + 独立组件）

新增 2 个文件 + 改 2 个文件：

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/renderer/src/composables/useMessageAnchors.ts` | 新建 | 注册/注销消息 DOM、`scrollToMessage(id)`、`activeId`（IntersectionObserver + hysteresis） |
| `src/renderer/src/components/chat/messages/MessageNavRail.vue` | 新建 | 横条 markup + tooltip + 点击调 scrollToMessage；接收 `userMessages` prop |
| `src/renderer/src/components/chat/messages/MessageItem.vue` | 改 | `<article>` 加 `data-message-id`；`onMounted`/`onUnmounted` 调 anchor 注册/注销（仅 user 消息） |
| `src/renderer/src/components/chat/messages/MessageList.vue` | 改 | 根层重构为 `relative` 外层 + 内嵌滚动容器；创建 anchor 实例 `provide` 给子组件；挂载 `<MessageNavRail>`；监听根层宽度 |

### provide / inject 传递

`MessageList` 创建 `useMessageAnchors(containerRef)` 实例，通过 `provide(ANCHOR_KEY, ...)` 下发：
- `MessageItem`（user 消息）`inject` 拿到 `register` / `unregister`，在 `onMounted` / `onUnmounted` 调用。
- `MessageNavRail` `inject` 拿到 `activeId` 和 `scrollToMessage`。

**为什么不用 props**：`MessageItem` 嵌套较深（4 层），prop drilling 冗长。`provide/inject` 是 Vue 在这种「跨层级共享同一实例」场景的惯用做法，项目里 `messageStore` / `uiStore` 也是全局 inject 的同类模式。

**inject 容错**：`inject(ANCHOR_KEY, null)`，为 `null` 时 `MessageItem` 跳过注册（向后兼容——未来若有别的消息列表不用侧轨，不会报错）。

## composable API

```ts
// useMessageAnchors.ts
import { type InjectionKey, type Ref, inject, provide, ref, onScopeDispose } from 'vue'

export interface MessageAnchorApi {
  activeId: Ref<string | null>
  register: (id: string, el: HTMLElement) => void
  unregister: (id: string) => void
  scrollToMessage: (id: string) => void
}

export const MESSAGE_ANCHOR_KEY: InjectionKey<MessageAnchorApi> = Symbol('message-anchor')

export function useMessageAnchors(scrollContainer: Ref<HTMLElement | null>): MessageAnchorApi {
  const anchors = new Map<string, HTMLElement>()
  const activeId = ref<string | null>(null)
  let observer: IntersectionObserver | null = null

  // 在 scrollContainer 挂载后惰性创建 observer（watch scrollContainer）
  // rootMargin '0px 0px -60% 0px'：只把视口上 40% 当作「激活区」
  // threshold [0, 0.5, 1]：足够细粒度比较 ratio 做 hysteresis

  function register(id: string, el: HTMLElement): void { /* anchors.set + observer.observe */ }
  function unregister(id: string): void { /* anchors.delete + observer.unobserve */ }
  function scrollToMessage(id: string): void { /* el.scrollIntoView */ }

  // onScopeDispose：组件销毁时 disconnect observer，避免泄漏
  return { activeId, register, unregister, scrollToMessage }
}
```

**惰性初始化**：`scrollContainer` 初始可能是 `null`（template ref 在 mount 后才有值），所以用 `watch(scrollContainer, ...)` 在 ref 就绪后创建 observer，而不是在 composable 顶层立即 `new IntersectionObserver`。

## 数据流

```
MessageList.vue
  ├─ useMessageAnchors(containerRef)  ← 创建实例
  ├─ provide(MESSAGE_ANCHOR_KEY, api) ← 下发
  │
  ├─ <div ref="container" class="overflow-y-auto ...">  ← 滚动容器（IntersectionObserver root）
  │    └─ <MessageItem v-for="...">  ← user 消息
  │         ├─ inject(MESSAGE_ANCHOR_KEY)
  │         ├─ onMounted: register(message.id, articleEl)
  │         ├─ onUnmounted: unregister(message.id)
  │         └─ <article :data-message-id="message.id">  ← 锚点
  │
  └─ <MessageNavRail :user-messages="userMessages" />  ← 兄弟节点，absolute 定位
       ├─ inject(MESSAGE_ANCHOR_KEY)  ← 拿 activeId + scrollToMessage
       └─ v-for="um in userMessages" 渲染横条
```

`userMessages` 由 `MessageList` 用 `computed` 从 `messageStore.messages` 过滤（`role === 'user'` 且非 `/compact` / 中断 sentinel——复用 `MessageItem` 已有的 `isCompactHistoryEntry` / `isInterruptedEntry` 判断，避免给这两种特殊条目也生成横条）。

## 边界情况

1. **`/compact` 与中断 sentinel 条目**：不生成横条（它们由 `CompactHistoryEntry` / `InterruptedHistoryEntry` 渲染，不是真正的用户提问）。在 `MessageList` 计算 `userMessages` 时过滤掉。
2. **会话切换**：`messageStore.messages` 变化 → `userMessages` 重算 → 旧锚点 `unregister`（`MessageItem` 卸载）、新锚点 `register`（新 `MessageItem` 挂载），`activeId` 重置为第一条。
3. **流式新增消息**：新 user 消息 push 时，`MessageItem` mount 自动注册；侧轨 `v-for` 自动新增横条。
4. **`scrollContainer` 还没挂载时**：composable 的 `watch(scrollContainer)` 确保惰性初始化，注册调用在 observer 就绪前会先入 `anchors` Map，observer 就绪后补 observe。
5. **横条数量极多**（>50）：性能上 DOM 横条本身轻量；IntersectionObserver 观测几十个元素无压力。不预先做虚拟化。

## 测试策略

- **composable 单测**（`useMessageAnchors.test.ts`，co-located）：
  - register/unregister 正确增删 Map。
  - `scrollToMessage` 调用 `el.scrollIntoView`（mock）。
  - observer 回调按预期更新 activeId（用 happy-dom 触发 intersection，或 mock `IntersectionObserver`）。
- **集成验证**：手动在 dev 里验证三种主题（dark / light）、hover、点击滚动、激活态切换、窄窗口隐藏、单条消息隐藏。

不写组件渲染快照测试——视觉效果靠手动验证，逻辑靠 composable 单测覆盖。

## 不引入的依赖

- 不用 `vueuse` 的 `useIntersectionObserver`（项目目前没用 vueuse，保持一致，自己写 80 行更可控）。
- 不用 `scrollmonitor` 等第三方滚动库——原生 IntersectionObserver 足够。

## 风险与权衡

- **provide/inject 的响应式**：`activeId` 是 `ref`，`provide` 整个 api 对象，inject 端拿到的 `activeId` 保持响应性（Vue 默认行为，无需 `toRefs`）。Rail 模板里直接 `inject(...).activeId` 即可触发重渲染。
- **`MessageList` 根层重构**：原本根元素就是滚动容器（同时是 sticky 按钮的定位上下文）。新增外层 `relative` 后，sticky 按钮、loading overlay 的定位上下文不变（它们相对滚动容器，外层只是包裹）。需在实现时验证「回到底部」按钮、loading 状态显示正常。
- **`px-6` 内边距与侧轨重叠**：侧轨宽 14px 落在 `px-6`（24px）的左 padding 内，不会挤压正文。若发现视觉拥挤，可把正文容器 `pl` 加 4px——但默认不动，保持现有间距。

## 实现顺序（写入计划文档时展开）

1. `useMessageAnchors.ts` composable + 单测。
2. `MessageNavRail.vue` 组件（含 tooltip、三态样式、provide key）。
3. `MessageItem.vue`：加 `data-message-id` + inject register/unregister。
4. `MessageList.vue`：根层重构、provide、挂载 Rail、宽度监听。
5. 手动验证三种主题 + 各交互。
6. `pnpm typecheck` + `pnpm lint` + composable 单测通过。
