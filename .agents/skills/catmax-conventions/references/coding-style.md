# 编码规范

## TypeScript 配置

### `tsconfig.json`（根）

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "paths": {
      "@shared/*": ["./src/shared/*"],
      "@main/*": ["./src/main/*"],
      "@renderer/*": ["./src/renderer/src/*"]
    }
  },
  "references": [
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.web.json" }
  ]
}
```

**关键严格选项**：
- `strict: true` — 全套严格检查
- `noUncheckedIndexedAccess: true` — `arr[0]` 类型是 `T | undefined`，强制检查
- `exactOptionalPropertyTypes: true` — `{ a?: string }` 不能传 `a: undefined`
- `verbatimModuleSyntax: true` — 强制 `import type` 分离类型导入

### 路径别名

| 别名 | 指向 | 谁能用 |
|---|---|---|
| `@shared/*` | `src/shared/*` | main + renderer + preload |
| `@main/*` | `src/main/*` | 仅 main |
| `@renderer/*` | `src/renderer/src/*` | 仅 renderer |

## 命名约定

| 类型 | 约定 | 例子 |
|---|---|---|
| 类型 / 接口 | PascalCase | `WorkspaceRecord`、`TurnEvent` |
| 枚举值 | PascalCase（union type 优先） | `'codex' \| 'claude'` |
| 函数 / 变量 | camelCase | `listWorkspaces`、`currentBackend` |
| 常量 | SCREAMING_SNAKE_CASE | `MAX_PREVIEW_SIZE`、`DEFAULT_PAGE_SIZE` |
| 私有（类成员） | 前缀 `_` | `this._adapter` |
| 布尔变量 | `is/has/can/should` 前缀 | `isLoading`、`hasUnsavedChanges` |
| React/Vue 事件 handler | `on+Verb` 或 `handle+Verb` | `onSend`、`handleApprove` |
| 文件 - Vue 组件 | PascalCase.vue | `MessageItem.vue` |
| 文件 - 其他 .ts | kebab-case.ts | `backend-manager.ts`、`ipc-registry.ts` |
| 文件 - 类型/契约 | 与 domain 同名 | `workspace.ts`（不是 `workspace-types.ts`） |
| 目录 | kebab-case | `backend-manager/`（不是 `backendManager/`） |
| IPC 方法 | `domain.verb` | `workspace.list`、`backend.startTurn` |
| IPC 推送事件 | `domain:event` | `backend:turnEvent`、`pty:data` |
| Pinia store id | `xxxStore` | `useMessageStore` → id `'message'` |
| Composable | `useXxx` | `useTheme`、`useStreamMessage` |

## IPC 命名细节

### 请求-响应方法（renderer → main → renderer）

格式：`<domain>.<verb>` 或 `<domain>.<noun>.<verb>`

```ts
// ✅ 好
'workspace.list'           // domain.verb
'workspace.add'            // domain.verb
'session.remove'           // domain.verb
'backend.startTurn'        // domain.noun.verb
'fs.readFilePreview'       // domain.noun.verb
'fs.openInEditor'          // domain.verb

// ❌ 避免
'getWorkspaceList'         // 没用 domain 前缀
'workspace/getList'        // 用了斜杠
'WORKSPACE_LIST'           // 全大写
```

### 推送事件（main → renderer）

格式：`<domain>:<event>`（用冒号区分请求-响应）

```ts
// ✅ 好
'backend:turnEvent'        // 流式 turn 事件
'backend:switched'         // 后端切换
'pty:data'                 // 终端输出
'pty:exit'                 // 终端退出

// ❌ 避免
'backend.turnEvent'        // 与请求方法混淆
'turnEvent'                // 缺 domain 前缀
```

## Vue SFC 结构

文件内部顺序：

```vue
<script setup lang="ts">
// 1. 类型导入（import type）
import type { Message } from '@shared/domain'
// 2. 库导入
import { computed, ref } from 'vue'
// 3. 组件导入
import MarkdownView from './MarkdownView.vue'
// 4. composables / stores
import { useMessageStore } from '@renderer/stores/message'
// 5. props / emits 定义
const props = defineProps<{ message: Message }>()
const emit = defineEmits<{ retry: []; copy: [text: string] }>()
// 6. 响应式状态
const isLoading = ref(false)
// 7. computed
const displayText = computed(() => props.message.textBlocks?.[0]?.text ?? '')
// 8. 方法
function handleRetry() { emit('retry') }
// 9. 生命周期（onMounted 等）
onMounted(() => { /* ... */ })
</script>

<template>
  <!-- 模板 -->
</template>

<style scoped>
/* 局部样式（首选 Tailwind，必要时才写） */
</style>
```

**规则**：
- 必用 `<script setup lang="ts">`，不用 Options API
- 必须 `scoped`，避免样式泄漏
- 模板优先用 Tailwind 类，复杂样式才 `<style>`
- 一个文件一个组件，文件名 = 组件名

## import 顺序

每个 import 块按以下顺序，组与组之间空一行：

```ts
// 1. Node 内置（仅 main）
import { readFile } from 'node:fs/promises'

// 2. 第三方
import { ref, computed } from 'vue'
import { z } from 'zod'

// 3. shared（跨进程类型）
import type { WorkspaceRecord } from '@shared/ipc/workspace'
import { BackendId } from '@shared/constants'

// 4. 本进程内部
import { db } from '@main/context'
import { useMessageStore } from '@renderer/stores/message'

// 5. 相对路径
import MarkdownView from './MarkdownView.vue'
```

ESLint `import/order` 规则强制。

## TypeScript 编码规则

### 用 union type 代替 enum

```ts
// ✅ 好（轻量、tree-shakeable、可推导字面量）
export type BackendId = 'codex' | 'claude'
export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'dontAsk' | 'bypassPermissions'

// ❌ 避免（运行时对象、不可 tree-shake）
export enum BackendId { Codex = 'codex', Claude = 'claude' }
```

**例外**：需要 reverse mapping 或值集合时可用 enum。

### 用 `type` 表达联合，用 `interface` 表达对象结构

```ts
// 联合 → type
export type TurnEvent = { type: 'text_delta'; ... } | { type: 'turn_completed'; ... }

// 对象结构 → interface
export interface WorkspaceRecord { id: string; path: string; ... }
```

### 严格区分类型导入

```ts
// ✅ verbatimModuleSyntax 要求
import type { WorkspaceRecord } from '@shared/ipc/workspace'
import { BackendId } from '@shared/constants'  // BackendId 是值（union 字面量也算值）

// ❌ 混在一起
import { WorkspaceRecord, BackendId } from '...'
```

### 错误处理：自定义错误类

```ts
// main/backend/types.ts
export class BackendError extends Error {
  constructor(
    public code: 'not-initialized' | 'not-installed' | 'mismatch' | 'protocol',
    message: string,
    public cause?: unknown,
  ) {
    super(message)
    this.name = 'BackendError'
  }
}

// 用
throw new BackendError('mismatch', `Session backend is ${record.backend}, current is ${current}`)
```

**规则**：
- 永远不要 `throw new Error('...')`（无法区分错误类型）
- 业务错误用自定义错误类
- 跨 IPC 边界返回时序列化为 `{ ok: false; error: { code, message } }`

## ESLint / Prettier 配置

### `.eslintrc.cjs`

```js
module.exports = {
  root: true,
  extends: [
    'plugin:vue/vue3-recommended',
    '@vue/eslint-config-typescript',
    'prettier',
  ],
  parserOptions: { ecmaVersion: 'latest' },
  rules: {
    // 强制 import 顺序
    'import/order': ['error', {
      groups: ['builtin', 'external', 'internal', 'parent', 'sibling'],
      'newlines-between': 'always',
      alphabetize: { order: 'asc' },
    }],
    // 禁止渲染层 import Node
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['electron', 'node:*'], message: 'Renderer cannot import Node APIs. Use IPC.', allowTypeImports: false },
      ],
    }],
    // Vue
    'vue/multi-word-component-names': 'off',
    'vue/component-name-in-template-casing': ['error', 'PascalCase'],
    // TS
    '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    '@typescript-eslint/no-floating-promises': 'error',
  },
  overrides: [
    { files: ['src/renderer/**'], rules: { /* renderer 限制 */ } },
    { files: ['src/main/**', 'src/preload/**'], rules: { /* main 放宽 */ } },
  ],
}
```

### `.prettierrc`

```json
{
  "semi": false,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "vueIndentScriptAndStyle": false
}
```

## Commit 规范（Conventional Commits）

格式：`<type>(<scope>): <subject>`

### Type 清单

| Type | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | bug 修复 |
| `refactor` | 重构（不改行为） |
| `perf` | 性能优化 |
| `docs` | 文档 |
| `test` | 测试 |
| `chore` | 构建、依赖、杂项 |
| `style` | 格式（不影响代码逻辑） |
| `ci` | CI 配置 |

### Scope（可选）

按 domain 或模块名：`feat(backend): ...`、`fix(ipc): ...`、`refactor(renderer): ...`

### 例子

```
feat(backend): add claude adapter with stream-json parsing
fix(ipc): handle session reconciliation when backend returns empty list
refactor(chat): split MessageItem into text and tool blocks
docs: add backend adapter pattern to catmax-conventions
chore: bump electron-vite to 3.0
```

## 提交前检查

```bash
pnpm lint         # ESLint
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run（如果改了逻辑）
```

CI 会强制这三项，本地先跑一遍省得来回。

## 文件头不需要版权注释

catmax-app 是自用项目，所有文件**不**写版权/许可证 header。保持文件顶部干净。
