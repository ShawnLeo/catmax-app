# 会话导航侧轨（Session Nav Rail）设计

**Date**: 2026-08-01
**Status**: Implemented
**Reference**: Codex 会话最左侧的横条导航

## 背景与目标

在 `MessageList` 最左侧增加一条会话目录侧轨：每条真正的用户消息对应一根横条，横条像 Codex 的刻度簇一样紧密相邻，当前阅读段落高亮；悬停或键盘聚焦时显示该条用户消息的完整正文；点击、Enter 或 Space 可滚动到对应消息。

视觉需适配暗色、亮色和 `prefers-reduced-motion`。功能同时覆盖默认消息 renderer（当前为 Claude）以及拥有专属 conversation renderer 的 Codex。

## 非目标

- 不做按文档实际高度映射的 minimap。
- 不为 assistant、tool、`/compact` 或中断 sentinel 生成横条。
- 不做所有消息的展开列表。
- 不引入虚拟滚动或第三方滚动监听库。预期几十条用户消息，原生滚动事件配合 `requestAnimationFrame` 足够。

## 总体结构

`MessageList` 根节点从滚动容器调整为 `relative` 包裹层，内部保留原滚动容器和 sticky“回到底部”按钮，再把 `MessageNavRail` 作为滚动容器的绝对定位兄弟节点。

```text
MessageList root（relative，接收 ChatView 的 flex-1）
├─ scroll container（overflow-y-auto，原有滚动与 sticky 内容）
│  └─ conversation renderer
│     ├─ MessageItem（默认 renderer）
│     └─ CodexConversation → CodexUserMessage（Codex renderer）
└─ MessageNavRail（absolute left-0，z-index 高于消息）
```

侧轨距聊天区最左边 5px，拥有 40px 透明交互宽度；横条本身默认约 8px、突出态约 24px。侧轨显示时，conversation 使用 `w-[calc(100%-2.5rem)]` 从总宽度扣除 40px，并将左侧 padding 提高到 40px，不能依赖原有 `px-4` / `px-6` 猜测可用空间：默认 renderer 使用 `pl-10 pr-6`，Codex renderer 使用 `pl-10 pr-4`。隐藏侧轨时恢复 `w-full` 和原 padding。

## 显示条件

以下条件全部满足时显示：

1. 可导航用户消息至少 2 条。
2. `MessageList` 实际布局宽度不小于 `MIN_WIDTH_FOR_RAIL = 640px`。
3. 非历史加载状态。

用 `ChatView` 的 `ResizeObserver` 观察中央聊天列的实际宽度。这样侧栏或右侧面板改变聊天区宽度时，侧轨能即时隐藏或恢复；同一个 `navRailVisible` 同时传给 MessageList、Composer、权限面板和提问面板，保证上下宽度一致。组件卸载时必须 `disconnect()`。

所有聊天表面统一使用 `chatContentWidthClass(navRailVisible)`：Claude 与 Codex 会话区、Composer 及两种反馈面板共享 `max-w-3xl lg:max-w-screen-lg xl:max-w-[1280px] 2xl:max-w-[1440px]`。这同时修复 Codex 过去只使用固定 `max-w-3xl`、宽屏下不会响应式扩展的问题。

## 可导航消息与预览文本

新增共享纯函数 `message-navigation.ts`，成为 Rail、默认 renderer 和 Codex renderer 的统一判定来源：

- `isNavigableUserMessage(message)`：`role === 'user'`，且第一个文本块不是 `/compact`，也不匹配 `matchInterruptMarker`。
- `navigationMessageText(message)`：从 `messageBlocks(message)` 读取全部非空 `text` 块，保留正文和段落换行，用于 tooltip 完整展示。
- `navigationPreview(message, limit = 120)`：在完整正文基础上折叠连续空白并截断，仅用于简洁的 `aria-label`，不用于 tooltip。
- 没有文本但带图片、附件或上下文时，使用“图片或附件消息”作为预览，不丢失该用户轮次。

tooltip 不截断消息。超长内容放在最大高度为视口 50% 的内部滚动区中，用户可把鼠标移入 tooltip 并滚动查看全部正文。

## 锚点契约

### provide / inject API

`MessageList` 创建一次 `useMessageAnchors(scrollContainerRef, sessionIdRef)`，并 provide：

```ts
interface MessageAnchorApi {
  activeId: Readonly<Ref<string | null>>
  register: (id: string, el: HTMLElement) => void
  unregister: (id: string, el?: HTMLElement) => void
  scrollToMessage: (id: string) => void
  refreshActive: () => void
}
```

`unregister` 接受可选元素引用，防止旧节点卸载时误删同 id 的新节点。

### 局部锚点指令

提供 `useMessageAnchorDirective()`，在 setup 中 inject 当前列表的 API，并返回局部 Vue directive：

- mounted：注册 `binding.value` 与根元素。
- updated：id 改变时先注销旧 id，再注册新 id。
- unmounted：注销当前节点。
- value 为 `null` 时跳过。

两条 renderer 路径都必须接入：

- `MessageItem` 的普通 `<article>`：仅真实 user 消息传 id。
- `CodexUserMessage` 的根元素：传 `message.id`。

这样新后端即便提供专属 conversation renderer，也能显式复用同一指令，不要求回退到 `MessageItem`。

## active scroll-spy

### 定义

active 表示当前阅读段落，而不是可见面积最大的消息：

1. 以滚动容器顶部下方 `ACTIVATION_OFFSET = 12px` 作为 activation line。
2. 按 DOM 几何位置排序所有已注册锚点。
3. 选择最后一条 `anchor.top <= container.top + ACTIVATION_OFFSET` 的消息。
4. 若尚无消息越过 activation line，选择最靠上的锚点。
5. 容器到达底部时强制选择最后一条，解决最后一条无法滚到顶部的情况。

不使用 `intersectionRatio`：消息高度会影响 ratio，无法稳定表达“当前阅读段落”。

### 调度

- 在滚动容器的 passive `scroll` 事件中用 `requestAnimationFrame` 合并计算，每帧最多一次。
- 注册、注销、容器 ref 变化以及 `snapToBottom()` 后主动刷新。
- 点击 Rail 时先乐观设置 `activeId`，再滚动；滚动期间 scroll-spy 会校正。
- `sessionId` 变化时同步清空 Map、取消待执行 rAF 并将 `activeId` 置空，不能假定 Vue 一定卸载所有旧节点。
- 容器或作用域销毁时移除 listener，并取消 rAF。

## 视觉与布局

| 状态                  | 颜色                     | 横条宽度 | 横条高度 |
| --------------------- | ------------------------ | -------: | -------: |
| 默认                  | `bg-muted-foreground/45` |      8px |      1px |
| active（滚动位置）    | `bg-foreground`          |      8px |      2px |
| hover / focus-visible | `bg-foreground`          |     24px |      2px |

- 横条始终从左向右伸长，使用 width 变化。
- 滚动产生的 active 只改变颜色和粗细，不改变默认 8px 长度；避免拖动滚动条时刻度不断伸缩。
- hover / focus 使用 Codex 式邻近阶梯：当前项 24px、相邻项 18px、相距两项 13px，其余保持 8px；只有当前交互项使用前景色，邻近项仅改变长度。
- 视觉横条放在透明 button 内，button 占满侧轨宽度并提供更大的命中区域。
- Rail 使用 `h-auto` 垂直居中，条目中心距约 9px、无额外 gap，形成与 Codex 截图一致的紧凑刻度簇；不再拉伸到容器高度。条目过多时 flex item 允许压缩，但横条自身不缩放。
- tooltip 位于 40px 交互区右侧并留 8px 间隔，宽度约 320px、圆角 12px、最大高度为视口 50%，保留正文换行并允许内部滚动。tooltip 与按钮间有透明 hover bridge，鼠标可移入阅读或滚动而不会消失。
- transition 使用 150ms；`motion-reduce:transition-none` 禁用视觉动画。

主题只使用语义 token，无需主题分支：暗色下突出态接近白色，亮色下接近黑色。

## 交互与可访问性

### 悬停与键盘聚焦

- 鼠标 hover 和键盘 focus 都会更新唯一的 tooltip 预览状态。
- Rail 用单一 `previewIndex = hoveredIndex ?? focusedIndex` 控制 tooltip，同一时刻最多显示一个。hover 优先于遗留 focus，避免点击一项后再悬停另一项产生浮层重叠。
- 鼠标点击跳转后主动移除按钮 focus；键盘 Enter / Space 激活仍保留 focus，保证键盘连续导航。
- tooltip 可接收鼠标滚轮；点击与滚轮事件不会冒泡到消息跳转或聊天滚动区。
- button 有明确的 `focus-visible` ring。
- `aria-label="跳转到第 N 条消息：{preview}"`。
- active button 使用 `aria-current="location"`。
- tooltip 使用稳定 id，并通过 `aria-describedby` 关联。

### 点击滚动

- 调用 `scrollIntoView({ block: 'start' })`。
- 普通偏好使用 `behavior: 'smooth'`；当 `prefers-reduced-motion: reduce` 时使用 `auto`。
- 锚点设置 `scroll-margin-top: 8px`。
- 即使最后一条受最大 scrollTop 限制无法贴顶，到底逻辑仍会正确激活最后一条。

## 文件结构

| 文件                                                                 | 操作 | 职责                                                          |
| -------------------------------------------------------------------- | ---- | ------------------------------------------------------------- |
| `src/renderer/src/lib/message-navigation.ts`                         | 新建 | 统一过滤可导航消息并生成预览文本                              |
| `src/renderer/src/lib/chat-layout.ts`                                | 新建 | 会话区、输入框和反馈面板共享响应式宽度规则                    |
| `src/renderer/src/composables/useMessageAnchors.ts`                  | 新建 | provide/inject API、锚点 Map、scroll-spy、跳转、session reset |
| `src/renderer/src/components/chat/messages/MessageNavRail.vue`       | 新建 | Rail、tooltip、鼠标与键盘交互                                 |
| `src/renderer/src/components/chat/messages/MessageItem.vue`          | 修改 | 默认 renderer 的 user article 接入锚点指令                    |
| `src/renderer/src/components/chat/blocks/codex/CodexUserMessage.vue` | 修改 | Codex user 根元素接入锚点指令                                 |
| `src/renderer/src/components/chat/messages/MessageList.vue`          | 修改 | 外层布局、provide、Rail、宽度观察、动态 gutter                |

## 边界情况

1. `/compact` 与中断 sentinel：统一纯函数过滤，既不展示 Rail 项，也不注册锚点。
2. 会话切换：显式 reset；directive 的 updated/unmounted 再完成 DOM 生命周期清理。
3. 流式新增用户消息：挂载时注册并自动新增 Rail 项。
4. 图片或附件消息：仍生成 Rail 项，preview 使用 fallback 文本。
5. 历史加载：Rail 隐藏；加载完成、DOM 挂载和自动滚底后重新计算 active。
6. 最后一条无法贴顶：到底时强制激活最后一条。
7. 大量条目：按钮垂直空间压缩，不创建额外 observer 或浮层列表。
8. API 未提供：局部指令容错为 no-op，独立渲染消息组件不会报错。

## 测试策略

### 纯函数

- 普通 user、assistant、`/compact`、两种中断 sentinel 的过滤。
- 多文本块完整拼接、ARIA 摘要空白折叠、Unicode 截断、无文本附件 fallback。
- 长消息 tooltip 不截断，并保留段落换行。

### composable

- register / unregister 与同 id 旧节点保护。
- 根据 activation line 选择 active，且不受消息高度影响。
- 到底时选择最后一条。
- 点击先更新 active，再调用正确的 `scrollIntoView` behavior。
- session 切换清空旧锚点。
- scope dispose 移除事件并取消 rAF。

### 组件与集成

- 少于两条、宽度不足、loading 时隐藏。
- Claude 与 Codex 两条 renderer 路径都能注册并跳转。
- hover 与 focus 显示 tooltip，active 带 `aria-current`。
- ResizeObserver 卸载清理。

视觉仍需在 dev 环境手动验证暗色、亮色、窄窗口、左右面板、长会话、回到底部按钮和 loading overlay。

## 验证命令

测试前必须先切到 Node ABI：

```bash
pnpm rebuild:node
pnpm test -- src/renderer/src/lib/message-navigation.test.ts \
  src/renderer/src/composables/useMessageAnchors.test.ts
pnpm typecheck
pnpm lint
```

## 实现顺序

1. 共享过滤/预览纯函数及测试。
2. 锚点 composable、局部 directive 及测试。
3. `MessageNavRail`。
4. 接入默认与 Codex renderer。
5. 重构 `MessageList` 外层、宽度观察和动态 gutter。
6. 手动验证与完整静态检查。
