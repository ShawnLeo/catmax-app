# UI 规范

## shadcn-vue 组件

### 组件统一放 `src/renderer/src/components/ui/`

```
components/ui/
├─ button/
│  ├─ Button.vue
│  └─ index.ts
├─ dialog/
│  ├─ Dialog.vue
│  ├─ DialogContent.vue
│  └─ index.ts
├─ input/
├─ select/
└─ ...
```

### 用 CLI 添加，不手写基础组件

```bash
npx shadcn-vue@latest add button
npx shadcn-vue@latest add dialog
npx shadcn-vue@latest add dropdown-menu
```

**规则**：
- 基础交互组件（button、input、dialog、select、tooltip、command）必须用 shadcn-vue 生成
- 业务组件自己写，放在 `components/<domain>/`
- **禁止手写**：modal、dropdown、tooltip、toast——全用 shadcn-vue

### `components.json` 配置

```json
{
  "$schema": "https://shadcn-vue.com/schema.json",
  "style": "default",
  "typescript": true,
  "tailwind": {
    "config": "tailwind.config.ts",
    "css": "src/renderer/src/assets/styles/main.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "framework": "vite",
  "aliases": {
    "components": "@renderer/components",
    "composables": "@renderer/composables",
    "utils": "@renderer/lib/utils"
  }
}
```

## 组件命名

### 文件名 = 组件名（PascalCase）

```
MessageItem.vue          → <MessageItem />
ChatComposer.vue         → <ChatComposer />
BackendSelector.vue      → <BackendSelector />
```

**不用** `index.vue`（除非目录就是组件名，如 `command/CommandPalette/index.vue`）。

### 业务组件按 domain 分目录

```
components/
├─ chat/           # 聊天主界面
│  ├─ MessageList.vue
│  ├─ MessageItem.vue
│  ├─ MarkdownView.vue
│  ├─ CodeBlock.vue
│  ├─ ToolCallCard.vue
│  ├─ ApprovalDialog.vue
│  └─ Composer.vue
├─ sidebar/
├─ workspace/
├─ git/
├─ files/
├─ terminal/
├─ settings/
├─ command/        # ⌘K 命令面板
└─ ui/             # shadcn-vue 基础组件（不要手写）
```

### 目录结构（每个组件）

单文件组件直接 `.vue`。复杂组件（含子组件）用目录：

```
command/
└─ CommandPalette/
   ├─ index.vue              # 主入口
   ├─ CommandPaletteInput.vue
   ├─ CommandPaletteItem.vue
   └─ types.ts               # 仅本组件用的类型
```

## Pinia store 规范

### 命名：`useXxxStore`

```ts
// stores/message.ts
export const useMessageStore = defineStore('message', () => {
  // ...
})
```

### 一领域一 store

| Store | 职责 |
|---|---|
| `useWorkspaceStore` | 工作区列表、当前工作区 |
| `useSessionStore` | 会话列表、当前会话 |
| `useMessageStore` | 当前会话的消息流（NormalizedMessage[]） |
| `useBackendStore` | 当前后端、模型列表、连接状态 |
| `useSettingsStore` | 全局设置（主题、字体、代理等） |
| `useUiStore` | UI 状态（侧边栏折叠、面板可见性、pendingApproval） |

**禁止**：跨领域共享 store（如把 message 和 backend 混在一起）。

### Store 内部结构（Composition API 风格）

```ts
export const useMessageStore = defineStore('message', () => {
  // 1. state
  const messages = ref<NormalizedMessage[]>([])
  const currentTurnId = ref<string | null>(null)
  
  // 2. getters
  const messageCount = computed(() => messages.value.length)
  const pendingApproval = computed(() => /* ... */)
  
  // 3. actions
  function appendText(turnId: string, text: string) { /* ... */ }
  function reset() {
    messages.value = []
    currentTurnId.value = null
  }
  
  return { messages, currentTurnId, messageCount, pendingApproval, appendText, reset }
})
```

**不用** Options API 风格的 store（`{ state, getters, actions }` 对象）。

## Composable 规范

### 命名：`useXxx`，返回响应式状态和方法

```ts
// composables/useTheme.ts
export function useTheme() {
  const settings = useSettingsStore()
  
  const mode = computed(() => settings.theme.mode)
  
  function apply(mode: 'light' | 'dark' | 'system') {
    const effective = mode === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : mode
    document.documentElement.setAttribute('data-theme', effective)
  }
  
  onMounted(() => apply(mode.value))
  watch(mode, (m) => apply(m))
  
  return { mode, apply }
}
```

### Composable vs Store 的边界

| 用 Store | 用 Composable |
|---|---|
| 跨组件共享的全局状态 | 单组件或小范围复用的逻辑 |
| 业务领域状态（会话、消息） | 工具逻辑（主题、终端、快捷键） |
| 需要 devtools 调试 | 不需要全局可见 |

### 常用 composable（一期需要的）

| Composable | 用途 |
|---|---|
| `useTheme` | 应用/切换主题，监听系统偏好 |
| `useStreamMessage` | 订阅 backend:turnEvent，累积 NormalizedMessage |
| `useTerminal` | xterm.js 生命周期、resize、清理 |
| `useShortcut` | 全局快捷键（⌘K、⌘N、⌘,） |
| `useFileDialog` | 选文件夹/文件（封装 dialog.showOpenDialog） |

## Tailwind v4 + 主题系统

### 三层 token 架构

```
Layer 1: 原始 token（Reference）—— 色板原料，OKLCH 表示
Layer 2: 语义 token（System）—— ★ 组件唯一能引用的层
Layer 3: 组件 token（Component）—— 按需
```

完整规范见设计文档第五章。这里讲实操。

### `themes.css`（主题定义）

```css
/* src/renderer/src/assets/styles/themes.css */

[data-theme="dark"] {
  /* Layer 1: 原始色板 */
  --color-gray-0:   oklch(99% 0 0);
  --color-gray-50:  oklch(20% 0.005 250);
  --color-gray-100: oklch(18% 0.006 250);
  --color-gray-900: oklch(95% 0.003 250);
  --color-brand-500: oklch(70% 0.15 250);
  
  /* Layer 2: 语义 token */
  --background:          var(--color-gray-100);
  --foreground:          var(--color-gray-900);
  --card:                var(--color-gray-50);
  --primary:             var(--color-brand-500);
  --primary-foreground:  var(--color-gray-0);
  --border:              oklch(28% 0.005 250 / 0.7);
  --radius:              8px;
  
  /* Layer 3: 组件 token */
  --sidebar-background:        var(--color-gray-50);
  --code-block-background:     oklch(12% 0.005 250);
}

[data-theme="light"] {
  --color-gray-50:  oklch(99% 0.001 80);
  /* ... light 派生 ... */
}

/* 字体（三个独立 token） */
:root {
  --font-sans: 'Inter', -apple-system, system-ui, sans-serif;
  --font-chat: 'Inter', -apple-system, system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'SF Mono', Menlo, monospace;
}
```

### `main.css`（Tailwind 注册）

```css
/* src/renderer/src/assets/styles/main.css */

@import "tailwindcss";
@import "./themes.css";

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  
  --radius-lg: var(--radius);
  --radius-md: calc(var(--radius) - 2px);
  --radius-sm: calc(var(--radius) - 4px);
  
  --font-sans: var(--font-sans);
  --font-chat: var(--font-chat);
  --font-mono: var(--font-mono);
}
```

### 主题切换机制

```ts
// composables/useTheme.ts
function apply(mode: 'light' | 'dark' | 'system') {
  const effective = mode === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : mode
  document.documentElement.setAttribute('data-theme', effective)
}
```

**唯一**切换主题的方式：改 `<html>` 的 `data-theme` 属性。

## 硬性规则

### 1. 组件只能引用 Layer 2 语义 token

```vue
<!-- ✅ 对 -->
<div class="bg-background text-foreground border border-border">
<button class="bg-primary text-primary-foreground">

<!-- ❌ 错（不可主题切换、不可扩展） -->
<div class="bg-[#1a1a1a] text-white">
<div class="bg-gray-900">  <!-- 用了 Tailwind 原生色阶 -->
```

ESLint 用 `no-restricted-syntax` 或自定义规则强制（搜索 `bg-[#`、`text-[#`）。

### 2. 新加主题 = 加 CSS 块，不改组件

```css
/* 加新主题，组件零修改 */
[data-theme="midnight"] {
  --color-gray-100: oklch(8% 0.01 280);
  --primary: oklch(60% 0.20 280);
  /* ... 其他 token ... */
}
```

### 3. OKLCH 而非 HEX/HSL

```css
/* ✅ 对（色彩感知均匀） */
--color-brand-500: oklch(70% 0.15 250);

/* ❌ 错 */
--color-brand-500: #3b82f6;
--color-brand-500: hsl(217, 91%, 60%);
```

### 4. 三个字体 token 互不替代

| Token | 用途 | 用法 |
|---|---|---|
| `--font-sans` | UI（按钮、菜单、对话框、侧边栏） | `font-sans` |
| `--font-chat` | 聊天消息正文 | `font-chat` |
| `--font-mono` | 代码块、终端、命令 | `font-mono` |

```vue
<!-- 聊天消息用 font-chat -->
<p class="font-chat leading-relaxed">{{ message.text }}</p>

<!-- 代码块用 font-mono -->
<code class="font-mono">{{ code }}</code>

<!-- UI 默认就是 font-sans（在 body 设置） -->
```

### 5. 不在 JS 里操作样式

```ts
// ❌ 错
el.style.background = '#1a1a1a'
el.classList.add('dark')

// ✅ 对（只改 data-theme）
document.documentElement.setAttribute('data-theme', 'dark')
```

## 消息列表（Codex 风格：无气泡）

```vue
<!-- components/chat/MessageList.vue -->
<template>
  <div class="flex flex-col gap-6 px-6 py-4">
    <MessageItem
      v-for="message in messages"
      :key="message.id"
      :message="message"
    />
  </div>
</template>
```

```vue
<!-- components/chat/MessageItem.vue -->
<template>
  <article class="flex gap-3">
    <!-- 头像 -->
    <MessageAvatar :role="message.role" class="mt-1" />
    
    <!-- 主内容 -->
    <div class="flex-1 min-w-0">
      <header class="flex items-baseline gap-2 mb-1">
        <span class="font-sans text-sm font-medium">{{ authorName }}</span>
        <time class="font-sans text-xs text-muted-foreground">{{ formatTime(message.createdAt) }}</time>
      </header>
      
      <!-- 文本块（用 font-chat） -->
      <MarkdownView
        v-for="block in message.textBlocks"
        :key="block.id"
        :text="block.text"
        :class="block.kind === 'reasoning' ? 'text-muted-foreground italic' : ''"
        class="font-chat leading-relaxed text-[15px]"
      />
      
      <!-- 工具调用块 -->
      <ToolCallCard
        v-for="tool in message.toolBlocks"
        :key="tool.id"
        :tool="tool"
        class="mt-2"
      />
    </div>
  </article>
</template>
```

**关键风格**：
- **无气泡**——全宽布局，用头像+名字+时间区分
- **`font-chat`**——聊天文本独立字体（默认 Inter，可设）
- **`leading-relaxed`**——行距偏宽
- **reasoning 块**用 `text-muted-foreground italic` 弱化

## Composer（居底、无边框感）

```vue
<!-- components/chat/Composer.vue -->
<template>
  <div class="border-t border-border bg-background">
    <!-- 工具条 -->
    <div class="flex items-center gap-2 px-4 py-2 border-b border-border">
      <BackendSelector v-model="backendId" />
      <ModelSelector v-model="modelId" :backend="backendId" />
      <EffortSelector v-model="effort" :backend="backendId" />
      <PermissionModeSelector v-model="permissionMode" :backend="backendId" />
    </div>
    
    <!-- 输入区 -->
    <textarea
      v-model="prompt"
      class="w-full bg-transparent font-chat text-[15px] px-4 py-3 resize-none focus:outline-none"
      placeholder="发送消息..."
      :rows="3"
      @keydown.enter.exact.prevent="send"
      @keydown.enter.shift="prompt += '\n'"
    />
    
    <!-- 底栏 -->
    <div class="flex items-center justify-between px-4 py-2">
      <span class="font-sans text-xs text-muted-foreground">
        Shift+Enter 换行
      </span>
      <button
        v-if="!isRunning"
        class="bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        :disabled="!prompt.trim()"
        @click="send"
      >
        发送
      </button>
      <button
        v-else
        class="bg-destructive text-white rounded-md px-3 py-1.5 text-sm font-medium"
        @click="interrupt"
      >
        停止
      </button>
    </div>
  </div>
</template>
```

**关键风格**：
- 背景与主区一致（`bg-background`），靠顶部细边线（`border-t border-border`）分隔
- 工具条紧凑（24-32px 高度）
- 输入区无边框（`bg-transparent focus:outline-none`）
- 发送/停止按钮在右下，停止用 `destructive` 色

## 侧边栏（窄、低饱和）

```vue
<!-- components/sidebar/Sidebar.vue -->
<template>
  <aside class="w-60 bg-sidebar-background border-r border-sidebar-border flex flex-col">
    <!-- 命令面板入口 -->
    <button class="m-2 px-3 py-1.5 text-sm rounded-md hover:bg-muted text-left">
      ⌘K 命令面板
    </button>
    
    <!-- 工作区切换 -->
    <WorkspaceSwitcher class="px-2 pb-2" />
    
    <!-- 会话列表 -->
    <SessionList class="flex-1 overflow-y-auto" />
    
    <!-- 底部 -->
    <div class="border-t border-border p-2 flex items-center justify-between">
      <BackendIndicator />
      <button class="p-1.5 rounded-md hover:bg-muted">
        <SettingsIcon class="w-4 h-4" />
      </button>
    </div>
  </aside>
</template>
```

**关键风格**：
- 固定 240px 宽（`w-60`）
- 背景略深（`bg-sidebar-background`，与主区有别）
- 文字小号（13px）
- 折叠模式：宽度变 56px（`w-14`），只显图标

## 图标

用 `lucide-vue-next`（shadcn-vue 默认配的图标库）：

```ts
import { Settings, Send, Square, MessageSquare } from 'lucide-vue-next'
```

**规则**：
- 统一 24px 视觉（`class="w-6 h-6"`），UI 中用 16-20px
- 用 `currentColor`，跟随父元素颜色

## Markdown 渲染

### 配置（`lib/markdown.ts`）

```ts
import MarkdownIt from 'markdown-it'
import Shiki from '@shikijs/markdown-it'

const md = new MarkdownIt({
  html: false,           // 禁用原生 HTML（安全）
  linkify: true,
  typographer: true,
})

// Shiki 代码高亮（Codex 同款）
md.use(await Shiki({
  themes: {
    dark: 'github-dark-dimmed',
    light: 'github-light',
  },
}))
```

### `MarkdownView.vue`

```vue
<template>
  <div class="markdown-body font-chat" v-html="rendered" />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { md } from '@renderer/lib/markdown'

const props = defineProps<{ text: string }>()
const rendered = computed(() => md.render(props.text))
</script>

<style scoped>
.markdown-body :deep(pre) {
  @apply bg-code-block-background rounded-md p-3 my-2 overflow-x-auto;
}
.markdown-body :deep(code) {
  @apply font-mono text-[13px];
}
.markdown-body :deep(a) {
  @apply text-primary underline;
}
</style>
```

## 字体加载

### 默认字体走 system stack（降级）

```css
:root {
  --font-sans: 'Inter', -apple-system, 'Helvetica Neue', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace;
}
```

Inter 不可用时降级到 SF Pro（macOS）/ Segoe UI（Windows）。

### 可选字体打包

把 Inter、JetBrains Mono 的 woff2 放 `resources/fonts/`，启动时 `@font-face` 加载：

```css
@font-face {
  font-family: 'Inter';
  src: url('@renderer/assets/fonts/Inter.woff2') format('woff2');
  font-weight: 100 900;
  font-display: swap;
}
```

## 反模式

### ❌ 组件写具体颜色

```vue
<div class="bg-[#1a1a1a] text-white dark:bg-white dark:text-black">
```

**正确**：`bg-background text-foreground`（主题自动适配）。

### ❌ 用 Tailwind 原生色阶

```vue
<div class="bg-gray-900 text-gray-100">
```

**正确**：`bg-card text-card-foreground`。

### ❌ 直接操作 inline style

```ts
el.style.background = '#1a1a1a'
```

**正确**：改 CSS 变量或 data-theme。

### ❌ 组件用 Options API

```vue
<script>
export default { data() { return { ... } } }
</script>
```

**正确**：`<script setup lang="ts">`。

### ❌ 基础交互组件手写

```vue
<!-- 自己实现 modal -->
<div v-if="show" class="fixed inset-0 bg-black/50">
  <div class="bg-white rounded-lg p-4">...</div>
</div>
```

**正确**：用 shadcn-vue 的 Dialog。

### ❌ Pinia store 用 Options 风格

```ts
defineStore('xxx', {
  state: () => ({ ... }),
  getters: { ... },
  actions: { ... },
})
```

**正确**：Composition API 风格（setup function）。
