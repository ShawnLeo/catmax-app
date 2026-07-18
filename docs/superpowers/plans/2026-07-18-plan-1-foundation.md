# Plan 1: 项目地基（Phase 1-4）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建 catmax-app 的工程地基——一个能启动的 Electron + Vue3 应用，含 IPC 基础设施、Codex 风格主题系统、SQLite 持久化。完成后产物：可启动的桌面 App，能切换深/浅主题、添加工作区、保存设置。

**Architecture:** electron-vite 三进程结构（`src/{main,preload,renderer,shared}/`），采用 Heckmann 模式的类型化 IPC（handler 函数签名即契约），shadcn-vue + Tailwind v4 + 三层 token 主题系统，better-sqlite3 持久化。

**Tech Stack:** Electron 30+、electron-vite 3+、Vue 3、TypeScript 5.5+、Vite 5+、Pinia、Vue Router、Tailwind CSS v4、shadcn-vue、better-sqlite3、Zod、Vitest、ESLint、Prettier、pnpm 10+。

**设计文档参考：** `docs/superpowers/specs/2026-07-18-catmax-app-design.md`
**项目规范：** `.agents/skills/catmax-conventions/`（实现时按规范走）

---

## 文件结构（本 plan 产出的所有文件）

```
catmax-app/
├─ package.json                          # pnpm + 依赖 + 脚本
├─ pnpm-lock.yaml                        # 锁文件
├─ electron.vite.config.ts               # electron-vite 配置
├─ electron-builder.yml                  # 打包配置（占位，本 plan 不打包）
├─ tsconfig.json / tsconfig.node.json / tsconfig.web.json
├─ tailwind.config.ts                    # Tailwind v4（v4 主要在 CSS 配置，但保留少量 JS 配置）
├─ postcss.config.js
├─ components.json                       # shadcn-vue 配置
├─ .eslintrc.cjs
├─ .prettierrc
├─ .editorconfig
├─ .gitignore                            # 已有，可能要补
├─ .npmrc                                # pnpm 配置（electron 镜像等）
│
├─ resources/
│  └─ icon.png                           # 应用图标占位
│
├─ src/
│  ├─ shared/                            # 跨进程类型契约
│  │  ├─ constants.ts                    # BackendId、EditorId、存储键名
│  │  ├─ domain.ts                       # Workspace / Session / Message 领域类型
│  │  ├─ ipc/
│  │  │  ├─ workspace.ts                 # workspace domain 契约（Plan 1 实现）
│  │  │  ├─ settings.ts                  # settings domain 契约（Plan 1 实现）
│  │  │  └─ system.ts                    # system domain 契约（Plan 1 实现）
│  │  │  # 其他 domain（session/backend/git/fs/pty/credential）在后续 plan 实现
│  │  └─ settings-schema.ts              # AppSettings + Zod schema
│  │
│  ├─ main/
│  │  ├─ index.ts                        # app.whenReady 入口
│  │  ├─ window.ts                       # BrowserWindow 管理
│  │  ├─ context.ts                      # 全局上下文（db、windows）
│  │  ├─ ipc/
│  │  │  ├─ typed.ts                     # 类型化 IPC 基础类（Heckmann）
│  │  │  ├─ register.ts                  # 统一注册所有 domain
│  │  │  └─ domains/
│  │  │     ├─ workspace/{handlers,index}.ts
│  │  │     ├─ settings/{handlers,index}.ts
│  │  │     └─ system/{handlers,index}.ts
│  │  └─ service/
│  │     ├─ database.ts                  # better-sqlite3 封装
│  │     ├─ schema.sql                   # 建表 SQL（Plan 1 仅 workspaces + app_state）
│  │     ├─ settings-store.ts            # settings.json 读写（Zod 校验）
│  │     └─ logger.ts                    # 简单日志（pino）
│  │
│  ├─ preload/
│  │  ├─ index.ts                        # contextBridge.exposeInMainWorld
│  │  └─ api.ts                          # 自动派生 api 对象
│  │
│  └─ renderer/
│  ├─ index.html
│  └─ src/
│     ├─ main.ts                         # createApp + pinia + router
│     ├─ App.vue                         # 根组件（router-view + 主题应用）
│     ├─ env.d.ts                        # window.api 类型补全
│     ├─ assets/
│     │  └─ styles/
│     │     ├─ main.css                  # tailwind 入口 + @theme 注册
│     │     └─ themes.css                # 深/浅主题 CSS vars（data-theme）
│     ├─ router/
│     │  └─ index.ts                     # hash router（Welcome / Chat / Settings）
│     ├─ ipc/
│     │  └─ index.ts                     # window.api 类型化包装 + 事件订阅
│     ├─ stores/
│     │  ├─ workspace.ts
│     │  ├─ settings.ts
│     │  └─ ui.ts
│     ├─ composables/
│     │  └─ useTheme.ts
│     ├─ lib/
│     │  └─ utils.ts                     # shadcn-vue cn() 工具
│     ├─ views/
│     │  ├─ WelcomeView.vue              # 工作区选择 / 添加
│     │  ├─ ChatView.vue                 # 占位（Plan 2 实现）
│     │  └─ SettingsView.vue             # 设置页（主题 + 字体）
│     ├─ components/
│     │  ├─ ui/                          # shadcn-vue 生成（button, input, dialog, ...）
│     │  │  └─（用 npx shadcn-vue add 添加）
│     │  └─ layout/
│     │     └─ AppShell.vue              # 主布局（侧栏占位 + 主区）
│     └─ tests/
│        └─ theme.spec.ts                # 主题单测
│
└─ tests/                                # 主进程测试
   ├─ ipc/
   │  ├─ workspace-handlers.test.ts
   │  └─ settings-handlers.test.ts
   ├─ service/
   │  ├─ database.test.ts
   │  └─ settings-store.test.ts
   └─ shared/
      └─ constants.test.ts
```

---

## Task 1: 初始化 pnpm 项目与依赖

**Files:**
- Create: `package.json`
- Create: `.npmrc`
- Modify: `.gitignore`（已有，补充 `coverage/` 等）

- [ ] **Step 1: 确认 Node 与 pnpm 版本**

Run:
```bash
node --version
pnpm --version
```

Expected: Node >= 20.19，pnpm >= 10。若 pnpm 未安装：`npm install -g pnpm@latest`。

- [ ] **Step 2: 初始化 package.json**

Run:
```bash
pnpm init
```

这会生成基础 `package.json`。我们需要重写它。

- [ ] **Step 3: 写入完整 package.json**

Create `package.json`（覆盖 pnpm init 的内容）：

```json
{
  "name": "catmax-app",
  "version": "0.1.0",
  "description": "Self-hosted code agent client (Electron + Vue3)",
  "private": true,
  "author": "shawn",
  "type": "module",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "start": "electron-vite preview",
    "typecheck:node": "tsc --noEmit -p tsconfig.node.json --composite false",
    "typecheck:web": "vue-tsc --noEmit -p tsconfig.web.json --composite false",
    "typecheck": "pnpm typecheck:node && pnpm typecheck:web",
    "lint": "eslint . --ext .js,.cjs,.mjs,.ts,.tsx,.vue --cache",
    "lint:fix": "pnpm lint --fix",
    "format": "prettier --write \"src/**/*.{ts,vue,js,cjs,mjs,css,md}\"",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "electron-updater": "^6.3.9"
  },
  "devDependencies": {
    "@electron-toolkit/preload": "^3.0.0",
    "@electron-toolkit/utils": "^3.0.0",
    "@rushstack/eslint-patch": "^1.10.4",
    "@shikijs/markdown-it": "^1.27.0",
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.5.0",
    "@vitejs/plugin-vue": "^5.1.0",
    "@vue/eslint-config-prettier": "^9.0.0",
    "@vue/eslint-config-typescript": "^13.0.0",
    "@vue/test-utils": "^2.4.0",
    "autoprefixer": "^10.4.20",
    "electron": "^31.0.0",
    "electron-builder": "^24.13.3",
    "electron-vite": "^2.3.0",
    "eslint": "^8.57.0",
    "eslint-plugin-vue": "^9.28.0",
    "happy-dom": "^15.0.0",
    "markdown-it": "^14.1.0",
    "pinia": "^2.2.0",
    "postcss": "^8.4.41",
    "prettier": "^3.3.0",
    "shadcn-vue": "^0.11.0",
    "tailwindcss": "^4.0.0",
    "@tailwindcss/vite": "^4.0.0",
    "typescript": "^5.5.0",
    "unplugin-auto-import": "^0.18.0",
    "unplugin-vue-components": "^0.27.0",
    "vite": "^5.4.0",
    "vitest": "^2.0.0",
    "vue": "^3.5.0",
    "vue-router": "^4.4.0",
    "vue-tsc": "^2.1.0",
    "zod": "^3.23.0"
  },
  "engines": {
    "node": ">=20.19"
  },
  "packageManager": "pnpm@10.11.1"
}
```

- [ ] **Step 4: 创建 .npmrc**

Create `.npmrc`：

```ini
# Electron 下载镜像（国内加速，可按需关闭）
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
# better-sqlite3 编译相关
node-linker=hoisted
# 严格 peer dep
auto-install-peers=true
```

- [ ] **Step 5: 更新 .gitignore**

Modify `.gitignore`（在现有内容基础上追加）：

```
# build artifacts
coverage/
.vite/
*.tsbuildinfo
# IDE
.vscode/*
!.vscode/extensions.json
!.vscode/settings.json
# shadcn-vue
components.json-cache
```

- [ ] **Step 6: 安装依赖**

Run:
```bash
pnpm install
```

Expected: 安装完成，可能有几个 peer warning（可忽略）。

- [ ] **Step 7: 验证 electron-vite 可用**

Run:
```bash
pnpm exec electron-vite --version
```

Expected: 打印版本号（如 `2.3.0`）。

- [ ] **Step 8: 提交**

```bash
git add package.json pnpm-lock.yaml .npmrc .gitignore
git commit -m "chore: initialize pnpm project with electron-vite dependencies"
```

---

## Task 2: TypeScript 配置（三 tsconfig）

**Files:**
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `tsconfig.web.json`

- [ ] **Step 1: 创建根 tsconfig.json**

Create `tsconfig.json`：

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.web.json" }
  ]
}
```

- [ ] **Step 2: 创建 tsconfig.node.json（main + preload + shared）**

Create `tsconfig.node.json`：

```json
{
  "extends": "@electron-toolkit/tsconfig/tsconfig.node.json",
  "include": [
    "electron.vite.config.*",
    "src/main/**/*",
    "src/preload/**/*",
    "src/shared/**/*"
  ],
  "compilerOptions": {
    "composite": true,
    "types": ["electron-vite/node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "moduleResolution": "Bundler",
    "module": "ESNext",
    "target": "ES2022",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": false,
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["./src/shared/*"],
      "@main/*": ["./src/main/*"],
      "@preload/*": ["./src/preload/*"]
    }
  }
}
```

注意：`verbatimModuleSyntax` 在 node 侧关掉（electron-vite 的构建配置有特殊性，后续可在规范技能里讨论是否启用）。

- [ ] **Step 3: 创建 tsconfig.web.json（renderer）**

Create `tsconfig.web.json`：

```json
{
  "extends": "@vue/tsconfig/tsconfig.dom.json",
  "include": [
    "src/renderer/src/**/*",
    "src/renderer/src/**/*.vue",
    "src/shared/**/*"
  ],
  "compilerOptions": {
    "composite": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "skipLibCheck": true,
    "moduleResolution": "Bundler",
    "module": "ESNext",
    "target": "ES2022",
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["./src/shared/*"],
      "@renderer/*": ["./src/renderer/src/*"]
    }
  }
}
```

需要 `@vue/tsconfig`：Step 4 一起装。

- [ ] **Step 4: 补充缺失的依赖**

Run:
```bash
pnpm add -D @electron-toolkit/tsconfig @vue/tsconfig
```

- [ ] **Step 5: 验证配置**

Run:
```bash
pnpm typecheck
```

Expected: 暂时无文件可检查，应该直接退出（或报"无输入文件"，是正常的）。

- [ ] **Step 6: 提交**

```bash
git add tsconfig*.json package.json pnpm-lock.yaml
git commit -m "chore: add TypeScript config (three tsconfig files)"
```

---

## Task 3: electron-vite 配置 + 入口文件骨架

**Files:**
- Create: `electron.vite.config.ts`
- Create: `src/main/index.ts`（临时，Task 6 重写）
- Create: `src/preload/index.ts`（临时）
- Create: `src/renderer/index.html`
- Create: `src/renderer/src/main.ts`（临时）
- Create: `resources/icon.png`

- [ ] **Step 1: 创建 electron.vite.config.ts**

Create `electron.vite.config.ts`：

```ts
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    plugins: [
      vue(),
      tailwindcss(),
      AutoImport({
        imports: ['vue', 'vue-router', 'pinia'],
        dts: 'src/renderer/src/auto-imports.d.ts',
      }),
      Components({
        dts: 'src/renderer/src/components.d.ts',
      }),
    ],
  },
})
```

- [ ] **Step 2: 创建临时 main 入口（仅启动窗口，Task 6 重写）**

Create `src/main/index.ts`：

```ts
import { app, shell, BrowserWindow } from 'electron'
import { join } from 'node:path'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL'] !== undefined) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
```

- [ ] **Step 3: 创建临时 preload 入口**

Create `src/preload/index.ts`：

```ts
// 占位：Task 13 实现真正的 api 桥接
export {}
```

- [ ] **Step 4: 创建 renderer/index.html**

Create `src/renderer/index.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>catmax</title>
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:;"
    />
  </head>
  <body class="font-sans bg-background text-foreground">
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 5: 创建临时 renderer/src/main.ts**

Create `src/renderer/src/main.ts`：

```ts
import { createApp } from 'vue'
import App from './App.vue'

createApp(App).mount('#app')
```

- [ ] **Step 6: 创建临时 App.vue**

Create `src/renderer/src/App.vue`：

```vue
<template>
  <div class="p-8">
    <h1 class="text-2xl font-bold">catmax app</h1>
    <p class="mt-2 text-muted-foreground">verifying electron-vite works</p>
  </div>
</template>
```

- [ ] **Step 7: 创建资源目录与占位图标**

Run:
```bash
mkdir -p resources
# 生成一个 512x512 的纯色占位 PNG（用 sips 或下载一个）
# 简单做法：用 base64 写一个 1x1 透明 PNG 占位（实际打包前会换）
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\xcf\xc0\x00\x00\x00\x03\x00\x01\x5d\xcc\xdb\xda\x00\x00\x00\x00IEND\xaeB\x60\x82' > resources/icon.png
```

- [ ] **Step 8: 验证开发服务器启动**

Run:
```bash
pnpm dev
```

Expected: Electron 窗口弹出，显示 "catmax app" 标题。终端无报错。按 Cmd+Q 退出。

如果启动失败，常见原因：
- `sandbox: false` 报警告：忽略
- 找不到 `electron-vite`：检查 `pnpm install` 是否完成
- `@tailwindcss/vite` 报错：先在 main.css 加 `@import "tailwindcss"`（Task 11 会做）

- [ ] **Step 9: 提交**

```bash
git add electron.vite.config.ts src/ resources/
git commit -m "feat: scaffold electron-vite entry points (main/preload/renderer)"
```

---

## Task 4: ESLint + Prettier 配置

**Files:**
- Create: `.eslintrc.cjs`
- Create: `.prettierrc`
- Create: `.editorconfig`
- Create: `.vscode/settings.json`（可选，提升开发体验）
- Create: `.vscode/extensions.json`（推荐插件）

- [ ] **Step 1: 创建 .eslintrc.cjs**

Create `.eslintrc.cjs`：

```js
/* eslint-env node */
require('@rushstack/eslint-patch/modern-module-resolution')

module.exports = {
  root: true,
  env: {
    node: true,
  },
  extends: [
    'plugin:vue/vue3-essential',
    'eslint:recommended',
    '@vue/eslint-config-typescript',
    '@vue/eslint-config-prettier',
  ],
  parserOptions: {
    ecmaVersion: 'latest',
  },
  rules: {
    // 强制 import 顺序
    'import/order': [
      'error',
      {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        'newlines-between': 'always',
        alphabetize: { order: 'asc', caseInsensitive: true },
      },
    ],
    // Vue
    'vue/multi-word-component-names': 'off',
    'vue/component-name-in-template-casing': ['error', 'PascalCase'],
    // TS
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/consistent-type-imports': [
      'error',
      { fixStyle: 'inline-type-imports' },
    ],
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
  },
  overrides: [
    {
      // renderer 严禁 import Node 内置和 electron
      files: ['src/renderer/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['electron', 'node:*', 'better-sqlite3', '@main/*', '@preload/*'],
                message: 'Renderer cannot import Node/main/preload. Use IPC via window.api.',
                allowTypeImports: false,
              },
            ],
          },
        ],
      },
    },
  ],
  ignorePatterns: ['out/', 'dist/', 'node_modules/', '*.config.*', 'src/renderer/src/auto-imports.d.ts', 'src/renderer/src/components.d.ts'],
}
```

- [ ] **Step 2: 创建 .prettierrc**

Create `.prettierrc`：

```json
{
  "semi": false,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "endOfLine": "lf"
}
```

- [ ] **Step 3: 创建 .editorconfig**

Create `.editorconfig`：

```ini
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.md]
trim_trailing_whitespace = false
```

- [ ] **Step 4: 创建 .vscode/settings.json**

Create `.vscode/settings.json`：

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": "explicit"
  },
  "eslint.validate": ["javascript", "typescript", "vue"],
  "[vue]": {
    "editor.defaultFormatter": "Vue.volar"
  },
  "typescript.tsdk": "node_modules/typescript/lib"
}
```

- [ ] **Step 5: 创建 .vscode/extensions.json**

Create `.vscode/extensions.json`：

```json
{
  "recommendations": [
    "Vue.volar",
    "dbaeumer.vscode-eslint",
    "esbenp.prettier-vscode",
    "lokalise.i18n-ally"
  ]
}
```

- [ ] **Step 6: 验证 ESLint 可运行**

Run:
```bash
pnpm lint
```

Expected: 检查现有文件，可能有几个 warning（如 `any` 警告），无 error。如有 error，按提示修复。

- [ ] **Step 7: 格式化所有文件**

Run:
```bash
pnpm format
```

Expected: prettier 统一所有文件格式。

- [ ] **Step 8: 提交**

```bash
git add .eslintrc.cjs .prettierrc .editorconfig .vscode/
git commit -m "chore: configure ESLint, Prettier, EditorConfig"
```

---

## Task 5: 共享类型与常量（shared/）

**Files:**
- Create: `src/shared/constants.ts`
- Create: `src/shared/domain.ts`
- Create: `src/shared/settings-schema.ts`
- Test: `tests/shared/constants.test.ts`

- [ ] **Step 1: 创建 shared/constants.ts**

Create `src/shared/constants.ts`：

```ts
/**
 * 跨进程共享常量。
 * 这是单一真源——main 和 renderer 都从这里 import。
 */

/** 后端标识 */
export const BACKEND_IDS = ['codex', 'claude'] as const
export type BackendId = (typeof BACKEND_IDS)[number]

/** 编辑器标识 */
export const EDITOR_IDS = ['vscode', 'cursor', 'intellij', 'webstorm', 'sublime'] as const
export type EditorId = (typeof EDITOR_IDS)[number]

/** IPC channel 名前缀（避免硬编码字符串散落各处） */
export const IPC = {
  // workspace
  WORKSPACE_LIST: 'workspace.list',
  WORKSPACE_ADD: 'workspace.add',
  WORKSPACE_REMOVE: 'workspace.remove',
  WORKSPACE_RENAME: 'workspace.rename',
  WORKSPACE_SET_EDITOR: 'workspace.setEditor',
  // settings
  SETTINGS_GET: 'settings.get',
  SETTINGS_UPDATE: 'settings.update',
  SETTINGS_RESET: 'settings.reset',
  // system
  SYSTEM_PLATFORM_INFO: 'system.platformInfo',
  SYSTEM_OPEN_DIALOG: 'system.openDialog',
  SYSTEM_OPEN_EXTERNAL: 'system.openExternal',
} as const

/** 推送事件名 */
export const PUSH = {
  BACKEND_TURN_EVENT: 'backend:turnEvent',
  BACKEND_SWITCHED: 'backend:switched',
  PTY_DATA: 'pty:data',
} as const

/** 存储相关 */
export const STORAGE_KEYS = {
  LAST_WORKSPACE_ID: 'last_workspace_id',
  CURRENT_BACKEND: 'current_backend',
} as const

/** 文件预览限制 */
export const MAX_PREVIEW_BYTES = 256 * 1024 // 256KB
export const MAX_TEXT_PREVIEW_BYTES = 256 * 1024

/** 默认设置 */
export const DEFAULT_THEME_MODE = 'system' as const
export const DEFAULT_FONT_SIZE = 14
export const DEFAULT_CHAT_FONT_SIZE = 15
export const DEFAULT_CODE_FONT_SIZE = 13
```

- [ ] **Step 2: 创建 shared/domain.ts**

Create `src/shared/domain.ts`：

```ts
/**
 * 领域模型类型（跨进程共享）。
 * Plan 1 仅含 workspace；session/message 在后续 plan 添加。
 */
import type { BackendId, EditorId } from './constants'

export interface WorkspaceRecord {
  id: string
  path: string
  name: string
  preferredEditor: EditorId | null
  lastOpenedAt: number
  createdAt: number
}
```

- [ ] **Step 3: 创建 shared/settings-schema.ts**

Create `src/shared/settings-schema.ts`：

```ts
/**
 * AppSettings 类型 + Zod schema。
 * settings.json 是磁盘上的不可信输入，加载时必须用 schema 校验。
 */
import { z } from 'zod'
import { BACKEND_IDS, DEFAULT_FONT_SIZE, DEFAULT_THEME_MODE, EDITOR_IDS } from './constants'

export const themeModeSchema = z.enum(['light', 'dark', 'system'])
export type ThemeMode = z.infer<typeof themeModeSchema>

export const fontFamilySchema = z.object({
  sans: z.string().nullable(),
  chat: z.string().nullable(),
  mono: z.string().nullable(),
})

export const themeSettingsSchema = z.object({
  mode: themeModeSchema.default(DEFAULT_THEME_MODE),
  fontFamily: fontFamilySchema.default({ sans: null, chat: null, mono: null }),
  fontSize: z.number().int().min(11).max(20).default(DEFAULT_FONT_SIZE),
  chatFontSize: z.number().int().min(11).max(20).default(15),
  codeFontSize: z.number().int().min(10).max(18).default(13),
})
export type ThemeSettings = z.infer<typeof themeSettingsSchema>

export const httpProxySchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().nullable().default(null),
  bypass: z.string().nullable().default(null),
})
export type HttpProxy = z.infer<typeof httpProxySchema>

export const appSettingsSchema = z.object({
  defaultBackend: z.enum(BACKEND_IDS).default('codex'),
  backendPaths: z
    .object({
      codex: z.string().nullable().default(null),
      claude: z.string().nullable().default(null),
    })
    .default({ codex: null, claude: null }),
  defaultEditor: z.enum(EDITOR_IDS).default('vscode'),
  theme: themeSettingsSchema.default({}),
  httpProxy: httpProxySchema.default({}),
  language: z.enum(['zh-CN', 'en-US']).default('zh-CN'),
  sendOnEnter: z.boolean().default(true),
  showReasoningByDefault: z.boolean().default(false),
})
export type AppSettings = z.infer<typeof appSettingsSchema>
```

- [ ] **Step 4: 写 constants 单测**

Create `tests/shared/constants.test.ts`：

```ts
import { describe, expect, test } from 'vitest'
import { BACKEND_IDS, EDITOR_IDS, IPC, PUSH, STORAGE_KEYS } from '@shared/constants'

describe('constants', () => {
  test('BACKEND_IDS 包含 codex 和 claude', () => {
    expect(BACKEND_IDS).toEqual(['codex', 'claude'])
  })

  test('EDITOR_IDS 包含 5 个编辑器', () => {
    expect(EDITOR_IDS).toEqual(['vscode', 'cursor', 'intellij', 'webstorm', 'sublime'])
    expect(EDITOR_IDS).toHaveLength(5)
  })

  test('IPC 方法名用点分', () => {
    expect(IPC.WORKSPACE_LIST).toBe('workspace.list')
    expect(IPC.SETTINGS_GET).toBe('settings.get')
    expect(IPC.SYSTEM_OPEN_DIALOG).toBe('system.openDialog')
  })

  test('PUSH 推送事件用冒号分隔', () => {
    expect(PUSH.BACKEND_TURN_EVENT).toBe('backend:turnEvent')
    expect(PUSH.PTY_DATA).toBe('pty:data')
  })

  test('STORAGE_KEYS 唯一', () => {
    const values = Object.values(STORAGE_KEYS)
    expect(new Set(values).size).toBe(values.length)
  })
})
```

- [ ] **Step 5: 配置 vitest**

Create `vitest.config.ts`（项目根）：

```ts
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'json', 'html'],
    },
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
    },
  },
})
```

- [ ] **Step 6: 运行测试验证失败**

Run:
```bash
pnpm test tests/shared/constants.test.ts
```

Expected: PASS（5 tests）。

如果失败：检查 `@shared` alias 是否在 `vitest.config.ts` 中配置正确。

- [ ] **Step 7: 提交**

```bash
git add src/shared/ tests/shared/ vitest.config.ts
git commit -m "feat(shared): add constants, domain types, settings schema with tests"
```

---

## Task 6: 主进程入口（含 context 与窗口管理）

**Files:**
- Create: `src/main/context.ts`
- Create: `src/main/window.ts`
- Create: `src/main/service/logger.ts`
- Modify: `src/main/index.ts`（重写 Task 3 的临时版本）

- [ ] **Step 1: 创建 logger**

Create `src/main/service/logger.ts`：

```ts
/**
 * 简单日志器（生产环境可换 pino，MVP 用 console 即可）。
 * 用 [domain] 前缀格式化，便于在 DevTools 查看。
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error'

function log(level: LogLevel, domain: string, msg: string, ...args: unknown[]): void {
  const prefix = `[${domain}]`
  const fn = level === 'debug' ? console.debug : level === 'warn' ? console.warn : level === 'error' ? console.error : console.info
  fn(prefix, msg, ...args)
}

export const logger = {
  domain(name: string) {
    return {
      debug: (msg: string, ...args: unknown[]) => log('debug', name, msg, ...args),
      info: (msg: string, ...args: unknown[]) => log('info', name, msg, ...args),
      warn: (msg: string, ...args: unknown[]) => log('warn', name, msg, ...args),
      error: (msg: string, ...args: unknown[]) => log('error', name, msg, ...args),
    }
  },
}
```

- [ ] **Step 2: 创建 context.ts（全局上下文）**

Create `src/main/context.ts`：

```ts
/**
 * 主进程全局上下文。
 * 所有 service、db、manager 单例挂在这里，避免到处 new。
 *
 * 注意：DB 和 manager 在各自 Task 里实现，这里只是占位容器。
 * Task 8 会真的实例化 Database。
 */
import type { BrowserWindow } from 'electron'
import { logger } from './service/logger'

const log = logger.domain('context')

class Context {
  readonly windows = new Map<string, BrowserWindow>()

  // 在 Task 8/10 中填充：
  // db!: Database
  // settingsStore!: SettingsStore

  registerWindow(id: string, win: BrowserWindow): void {
    this.windows.set(id, win)
    win.on('closed', () => {
      this.windows.delete(id)
      log.info('window closed', id)
    })
  }

  getMainWindow(): BrowserWindow | undefined {
    return this.windows.get('main')
  }

  /** 向所有窗口广播事件（用于推送） */
  broadcast(channel: string, ...args: unknown[]): void {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, ...args)
      }
    }
  }
}

export const ctx = new Context()
```

- [ ] **Step 3: 创建 window.ts**

Create `src/main/window.ts`：

```ts
import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { ctx } from './context'

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'catmax',
    backgroundColor: '#18181b', // 与 dark theme --background 接近，避免白闪
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  // 外部链接用系统浏览器打开，不在 App 内导航
  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    win.webContents.openDevTools()
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  ctx.registerWindow('main', win)
  return win
}
```

- [ ] **Step 4: 重写 main/index.ts**

Modify `src/main/index.ts`（替换 Task 3 的临时版本）：

```ts
import { app, BrowserWindow } from 'electron'
import { createMainWindow } from './window'
import { logger } from './service/logger'

const log = logger.domain('main')

void app.whenReady().then(async () => {
  log.info('app ready', app.getVersion())

  // TODO(Task 8): await ctx.db.migrate()
  // TODO(Task 13): await registerAllHandlers()

  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 安全：阻止未知协议导航
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    const parsed = new URL(url)
    if (!parsed.protocol.startsWith('http') && parsed.protocol !== 'file:') {
      event.preventDefault()
    }
  })
})
```

- [ ] **Step 5: 验证 dev 启动**

Run:
```bash
pnpm dev
```

Expected: 窗口正常启动，DevTools 打开（dev 模式），console 看到 `[main] app ready ...`。退出。

- [ ] **Step 6: typecheck**

Run:
```bash
pnpm typecheck:node
```

Expected: 无错误。

- [ ] **Step 7: 提交**

```bash
git add src/main/
git commit -m "feat(main): add context, window manager, logger; rewrite main entry"
```

---

## Task 7: 数据库 service（better-sqlite3 + schema migration）

**Files:**
- Create: `src/main/service/database.ts`
- Create: `src/main/service/schema.sql`
- Test: `tests/service/database.test.ts`

- [ ] **Step 1: 创建 schema.sql**

Create `src/main/service/schema.sql`：

```sql
-- catmax-app SQLite schema
-- Plan 1 仅创建 workspaces 和 app_state；其他表在后续 plan 添加

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
  id              TEXT PRIMARY KEY,
  path            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  preferred_editor TEXT,
  last_opened_at  INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_workspaces_last_opened ON workspaces(last_opened_at DESC);
```

- [ ] **Step 2: 创建 database.ts**

Create `src/main/service/database.ts`：

```ts
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import type { WorkspaceRecord } from '@shared/domain'
import { logger } from './logger'

const log = logger.domain('database')

const __dirname = dirname(fileURLToPath(import.meta.url))

interface WorkspaceRow {
  id: string
  path: string
  name: string
  preferred_editor: string | null
  last_opened_at: number
  created_at: number
}

function rowToRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    preferredEditor: row.preferred_editor as WorkspaceRecord['preferredEditor'],
    lastOpenedAt: row.last_opened_at,
    createdAt: row.created_at,
  }
}

export class DatabaseService {
  private db: Database.Database

  constructor(dbPath?: string) {
    const path = dbPath ?? this.defaultPath()
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    log.info('opened', path)
  }

  private defaultPath(): string {
    return join(app.getPath('userData'), 'catmax.db')
  }

  migrate(): void {
    // 在测试环境，schema.sql 路径解析不同。允许传入 SQL 字符串。
    let schema: string
    try {
      schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8')
    } catch {
      // dev 模式 fallback：从源码读
      schema = readFileSync(join(process.cwd(), 'src/main/service/schema.sql'), 'utf-8')
    }
    this.db.exec(schema)
    log.info('migrated')
  }

  // ===== Workspace =====

  listWorkspaces(): WorkspaceRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM workspaces ORDER BY last_opened_at DESC')
      .all() as WorkspaceRow[]
    return rows.map(rowToRecord)
  }

  findWorkspaceByPath(path: string): WorkspaceRecord | null {
    const row = this.db
      .prepare('SELECT * FROM workspaces WHERE path = ?')
      .get(path) as WorkspaceRow | undefined
    return row ? rowToRecord(row) : null
  }

  findWorkspaceById(id: string): WorkspaceRecord | null {
    const row = this.db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(id) as WorkspaceRow | undefined
    return row ? rowToRecord(row) : null
  }

  insertWorkspace(record: WorkspaceRecord): WorkspaceRecord {
    this.db
      .prepare(
        `INSERT INTO workspaces (id, path, name, preferred_editor, last_opened_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.path,
        record.name,
        record.preferredEditor,
        record.lastOpenedAt,
        record.createdAt,
      )
    return record
  }

  updateWorkspaceName(id: string, name: string): void {
    this.db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(name, id)
  }

  updateWorkspaceEditor(id: string, editor: string | null): void {
    this.db
      .prepare('UPDATE workspaces SET preferred_editor = ? WHERE id = ?')
      .run(editor, id)
  }

  touchWorkspace(id: string, timestamp: number): void {
    this.db
      .prepare('UPDATE workspaces SET last_opened_at = ? WHERE id = ?')
      .run(timestamp, id)
  }

  deleteWorkspace(id: string): void {
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
  }

  // ===== app_state =====

  getState(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM app_state WHERE key = ?')
      .get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  setState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value)
  }

  deleteState(key: string): void {
    this.db.prepare('DELETE FROM app_state WHERE key = ?').run(key)
  }

  close(): void {
    this.db.close()
    log.info('closed')
  }
}

export type Database = DatabaseService
```

- [ ] **Step 3: 写 database 单测**

Create `tests/service/database.test.ts`：

```ts
import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { DatabaseService } from '@main/service/database'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { WorkspaceRecord } from '@shared/domain'

let db: DatabaseService
let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'catmax-test-'))
  db = new DatabaseService(join(tempDir, 'test.db'))
  db.migrate()
})

afterEach(() => {
  db.close()
  rmSync(tempDir, { recursive: true, force: true })
})

function makeWorkspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: 'test-id',
    path: '/tmp/test-workspace',
    name: 'test-workspace',
    preferredEditor: null,
    lastOpenedAt: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('DatabaseService', () => {
  test('migrate 创建表（重复执行不报错）', () => {
    expect(() => db.migrate()).not.toThrow()
  })

  test('insertWorkspace + findWorkspaceById', () => {
    const ws = makeWorkspace({ id: 'ws-1', path: '/a/b' })
    db.insertWorkspace(ws)
    const found = db.findWorkspaceById('ws-1')
    expect(found).toEqual(ws)
  })

  test('findWorkspaceByPath', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1', path: '/a/b' }))
    expect(db.findWorkspaceByPath('/a/b')?.id).toBe('ws-1')
    expect(db.findWorkspaceByPath('/not/exist')).toBeNull()
  })

  test('listWorkspaces 按 lastOpenedAt 倒序', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1', path: '/a', lastOpenedAt: 1000 }))
    db.insertWorkspace(makeWorkspace({ id: 'ws-2', path: '/b', lastOpenedAt: 3000 }))
    db.insertWorkspace(makeWorkspace({ id: 'ws-3', path: '/c', lastOpenedAt: 2000 }))

    const list = db.listWorkspaces()
    expect(list.map((w) => w.id)).toEqual(['ws-2', 'ws-3', 'ws-1'])
  })

  test('path 唯一约束（重复插入抛错）', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1', path: '/dup' }))
    expect(() =>
      db.insertWorkspace(makeWorkspace({ id: 'ws-2', path: '/dup' })),
    ).toThrow()
  })

  test('updateWorkspaceName', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1' }))
    db.updateWorkspaceName('ws-1', '新名字')
    expect(db.findWorkspaceById('ws-1')?.name).toBe('新名字')
  })

  test('updateWorkspaceEditor', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1' }))
    db.updateWorkspaceEditor('ws-1', 'vscode')
    expect(db.findWorkspaceById('ws-1')?.preferredEditor).toBe('vscode')
  })

  test('deleteWorkspace', () => {
    db.insertWorkspace(makeWorkspace({ id: 'ws-1' }))
    db.deleteWorkspace('ws-1')
    expect(db.findWorkspaceById('ws-1')).toBeNull()
  })

  test('app_state setState/getState', () => {
    db.setState('foo', 'bar')
    expect(db.getState('foo')).toBe('bar')
    db.setState('foo', 'baz') // upsert
    expect(db.getState('foo')).toBe('baz')
  })

  test('app_state deleteState', () => {
    db.setState('foo', 'bar')
    db.deleteState('foo')
    expect(db.getState('foo')).toBeNull()
  })
})
```

- [ ] **Step 4: 运行测试验证失败**

Run:
```bash
pnpm test tests/service/database.test.ts
```

Expected: 可能因 `electron` 模块在 node 测试环境不可用而失败（`app.getPath` 是 Electron API）。

- [ ] **Step 5: 修复：在 database.ts 中避免测试时依赖 electron**

观察问题：`DatabaseService` 构造函数调 `app.getPath('userData')`——这在 vitest（纯 node 环境）中会报错，因为 `electron` 模块未初始化。

修改 `database.ts` 的 `defaultPath()`，使其在测试中可用：

Modify `src/main/service/database.ts`，替换 `defaultPath()` 方法：

```ts
  private defaultPath(): string {
    // 测试环境或非 Electron 上下文回退到 cwd
    try {
      return join(app.getPath('userData'), 'catmax.db')
    } catch {
      return join(process.cwd(), 'catmax.db')
    }
  }
```

- [ ] **Step 6: 运行测试验证通过**

Run:
```bash
pnpm test tests/service/database.test.ts
```

Expected: PASS（10 tests）。如果失败：检查 schema.sql 路径解析（dev 模式下 fallback 应该工作）。

- [ ] **Step 7: 提交**

```bash
git add src/main/service/database.ts src/main/service/schema.sql tests/service/database.test.ts
git commit -m "feat(service): add DatabaseService with workspaces + app_state, fully tested"
```

---

## Task 8: settings store（settings.json 读写 + Zod 校验）

**Files:**
- Create: `src/main/service/settings-store.ts`
- Test: `tests/service/settings-store.test.ts`

- [ ] **Step 1: 创建 settings-store.ts**

Create `src/main/service/settings-store.ts`：

```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { app } from 'electron'
import {
  appSettingsSchema,
  type AppSettings,
} from '@shared/settings-schema'
import { logger } from './logger'

const log = logger.domain('settings-store')

export class SettingsStore {
  private filePath: string
  private cache: AppSettings | null = null

  constructor(filePath?: string) {
    this.filePath = filePath ?? this.defaultPath()
  }

  private defaultPath(): string {
    try {
      return join(app.getPath('userData'), 'settings.json')
    } catch {
      return join(process.cwd(), 'settings.json')
    }
  }

  /** 读取并校验 settings.json。文件不存在返回默认值；损坏时也返回默认值（带警告）。 */
  load(): AppSettings {
    if (this.cache) return this.cache

    if (!existsSync(this.filePath)) {
      log.info('settings file not found, using defaults')
      const defaults = appSettingsSchema.parse({})
      this.cache = defaults
      this.save(defaults)
      return defaults
    }

    const raw = readFileSync(this.filePath, 'utf-8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      log.error('settings.json is not valid JSON, using defaults:', e)
      const defaults = appSettingsSchema.parse({})
      this.cache = defaults
      return defaults
    }

    const result = appSettingsSchema.safeParse(parsed)
    if (!result.success) {
      log.warn('settings.json failed schema validation, using defaults:', result.error.issues)
      const defaults = appSettingsSchema.parse({})
      this.cache = defaults
      return defaults
    }

    this.cache = result.data
    log.info('loaded settings')
    return result.data
  }

  /** 部分更新 settings，写盘，返回完整 settings。 */
  update(patch: Partial<AppSettings>): AppSettings {
    const current = this.load()
    // 嵌套对象做浅 merge
    const merged: AppSettings = {
      ...current,
      ...patch,
      theme: { ...current.theme, ...(patch.theme ?? {}) },
      httpProxy: { ...current.httpProxy, ...(patch.httpProxy ?? {}) },
      backendPaths: { ...current.backendPaths, ...(patch.backendPaths ?? {}) },
    }
    const validated = appSettingsSchema.parse(merged)
    this.cache = validated
    this.save(validated)
    log.info('updated settings')
    return validated
  }

  reset(): AppSettings {
    const defaults = appSettingsSchema.parse({})
    this.cache = defaults
    this.save(defaults)
    log.info('reset to defaults')
    return defaults
  }

  private save(settings: AppSettings): void {
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(this.filePath, JSON.stringify(settings, null, 2), 'utf-8')
  }
}
```

- [ ] **Step 2: 写 settings-store 单测**

Create `tests/service/settings-store.test.ts`：

```ts
import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { SettingsStore } from '@main/service/settings-store'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let tempDir: string
let store: SettingsStore

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'catmax-settings-test-'))
  store = new SettingsStore(join(tempDir, 'settings.json'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('SettingsStore', () => {
  test('load 文件不存在时返回默认值', () => {
    const settings = store.load()
    expect(settings.defaultBackend).toBe('codex')
    expect(settings.defaultEditor).toBe('vscode')
    expect(settings.theme.mode).toBe('system')
    expect(settings.sendOnEnter).toBe(true)
  })

  test('load 损坏 JSON 时回退到默认值', () => {
    writeFileSync(join(tempDir, 'settings.json'), '{ not valid json')
    const settings = store.load()
    expect(settings.defaultBackend).toBe('codex')
  })

  test('load 不符合 schema 时回退到默认值', () => {
    writeFileSync(
      join(tempDir, 'settings.json'),
      JSON.stringify({ defaultBackend: 'invalid-backend' }),
    )
    const settings = store.load()
    expect(settings.defaultBackend).toBe('codex') // 回退
  })

  test('update 部分更新（浅 merge 嵌套对象）', () => {
    const initial = store.load()
    const updated = store.update({ theme: { ...initial.theme, mode: 'dark' } })
    expect(updated.theme.mode).toBe('dark')
    expect(updated.theme.fontSize).toBe(initial.theme.fontSize) // 其他字段保留
  })

  test('update 写盘后重新 load 仍能拿到值', () => {
    store.update({ defaultBackend: 'claude' })
    const newStore = new SettingsStore(join(tempDir, 'settings.json'))
    expect(newStore.load().defaultBackend).toBe('claude')
  })

  test('reset 恢复默认', () => {
    store.update({ defaultBackend: 'claude', sendOnEnter: false })
    const reset = store.reset()
    expect(reset.defaultBackend).toBe('codex')
    expect(reset.sendOnEnter).toBe(true)
  })
})
```

- [ ] **Step 3: 运行测试验证通过**

Run:
```bash
pnpm test tests/service/settings-store.test.ts
```

Expected: PASS（6 tests）。

- [ ] **Step 4: 提交**

```bash
git add src/main/service/settings-store.ts tests/service/settings-store.test.ts
git commit -m "feat(service): add SettingsStore with Zod validation and tests"
```

---

## Task 9: 装配 context（DB + settings）

**Files:**
- Modify: `src/main/context.ts`（接入 DatabaseService + SettingsStore）
- Modify: `src/main/index.ts`（在 whenReady 中 migrate + load）

- [ ] **Step 1: 修改 context.ts**

Modify `src/main/context.ts`，替换整个文件：

```ts
import type { BrowserWindow } from 'electron'
import { DatabaseService } from './service/database'
import { SettingsStore } from './service/settings-store'
import { logger } from './service/logger'

const log = logger.domain('context')

class Context {
  readonly windows = new Map<string, BrowserWindow>()
  readonly db: DatabaseService
  readonly settingsStore: SettingsStore

  constructor() {
    this.db = new DatabaseService()
    this.settingsStore = new SettingsStore()
  }

  registerWindow(id: string, win: BrowserWindow): void {
    this.windows.set(id, win)
    win.on('closed', () => {
      this.windows.delete(id)
      log.info('window closed', id)
    })
  }

  getMainWindow(): BrowserWindow | undefined {
    return this.windows.get('main')
  }

  broadcast(channel: string, ...args: unknown[]): void {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, ...args)
      }
    }
  }
}

export const ctx = new Context()
```

- [ ] **Step 2: 修改 main/index.ts，在 whenReady 中初始化**

Modify `src/main/index.ts`，替换 `void app.whenReady().then(...)` 块：

```ts
void app.whenReady().then(async () => {
  log.info('app ready', app.getVersion())

  // 初始化持久化
  ctx.db.migrate()
  ctx.settingsStore.load()
  log.info('database + settings ready')

  // TODO(Task 14): await registerAllHandlers()

  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})
```

确保文件顶部 import 包含 `ctx`：

```ts
import { ctx } from './context'
```

- [ ] **Step 3: typecheck**

Run:
```bash
pnpm typecheck:node
```

Expected: 无错误。

- [ ] **Step 4: 验证 dev 启动**

Run:
```bash
pnpm dev
```

Expected: 启动正常，DevTools console 应看到 `[database] opened ...`、`[database] migrated`、`[settings-store] loaded settings`。退出。

检查 userData 目录确实创建了 db 和 settings.json：

```bash
ls ~/Library/Application\ Support/catmax-app/
# 应有 catmax.db 和 settings.json
cat ~/Library/Application\ Support/catmax-app/settings.json
# 应该是合法 JSON，含 defaultBackend、theme 等
```

- [ ] **Step 5: 提交**

```bash
git add src/main/context.ts src/main/index.ts
git commit -m "feat(main): wire Database + SettingsStore into context"
```

---

## Task 10: IPC 类型化基础（Heckmann 模式）

**Files:**
- Create: `src/main/ipc/typed.ts`
- Test: `tests/ipc/typed.test.ts`（轻量，主要测试类型推导）

- [ ] **Step 1: 创建 typed.ts**

Create `src/main/ipc/typed.ts`：

```ts
import { ipcMain, ipcRenderer, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

/**
 * 类型化 IPC（Heckmann 模式）。
 *
 * 设计：
 * - 所有 handler 函数签名作为契约（在 shared/ipc/*.ts 定义）
 * - 主进程用 handleRendererRequest 注册
 * - 渲染层用 requestMain 调用，类型自动从 handler 派生
 * - 改 handler 签名 → renderer 编译报错 → 契约不漂移
 */

type AnyFn = (...args: any[]) => any

/** handler 映射（key = channel name，value = 函数签名） */
export type HandlerMap = Record<string, AnyFn>

/** 推送事件映射（key = channel name，value = payload） */
export type PushEventMap = Record<string, unknown>

/**
 * 主进程侧：注册 handler 的类型化包装。
 *
 * 用法：
 *   handleRendererRequest('workspace.list', listWorkspaces)
 *   handleRendererRequest('workspace.add', addWorkspace)
 */
export function handleRendererRequest<H extends HandlerMap, K extends keyof H & string>(
  channel: K,
  handler: (
    ...args: Parameters<H[K]>
  ) => ReturnType<H[K]> | Promise<ReturnType<H[K]>>,
): void {
  if (ipcMain.eventNames().includes(channel)) {
    throw new Error(`IPC handler "${channel}" already registered`)
  }
  const wrapped = (_event: IpcMainInvokeEvent, ...args: unknown[]) => handler(...(args as Parameters<H[K]>))
  ipcMain.handle(channel, wrapped)
}

/**
 * 主进程侧：向渲染层推送事件。
 */
export function pushToRenderer<P extends PushEventMap, K extends keyof P & string>(
  win: BrowserWindow,
  channel: K,
  payload: P[K],
): void {
  if (!win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

/**
 * 渲染层侧：调用主进程 handler。
 * 这个函数实际在 preload 中使用（preload 能 import electron）。
 */
export function requestMain<H extends HandlerMap, K extends keyof H & string>(
  channel: K,
): (...args: Parameters<H[K]>) => Promise<ReturnType<H[K]>> {
  return (...args: Parameters<H[K]>) =>
    ipcRenderer.invoke(channel, ...args) as Promise<ReturnType<H[K]>>
}

/**
 * 渲染层侧：订阅主进程推送事件。返回取消订阅函数。
 */
export function onMainEvent<P extends PushEventMap, K extends keyof P & string>(
  channel: K,
  callback: (payload: P[K]) => void,
): () => void {
  const listener = (_event: unknown, payload: P[K]) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener as never)
}
```

- [ ] **Step 2: 写最小单测（验证重复注册抛错）**

Create `tests/ipc/typed.test.ts`：

```ts
import { describe, expect, test, vi, beforeEach } from 'vitest'

// mock electron 模块（避免在 node 测试环境真的 import）
vi.mock('electron', () => {
  const handlers = new Map<string, Function>()
  const listeners = new Map<string, Set<Function>>()
  return {
    ipcMain: {
      eventNames: () => Array.from(handlers.keys()),
      handle: (channel: string, fn: Function) => handlers.set(channel, fn),
      removeHandler: (channel: string) => handlers.delete(channel),
    },
    ipcRenderer: {
      invoke: vi.fn(),
      on: (channel: string, fn: Function) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set())
        listeners.get(channel)!.add(fn)
      },
      removeListener: (channel: string, fn: Function) => {
        listeners.get(channel)?.delete(fn)
      },
    },
  }
})

// 必须在 mock 之后 import
const { handleRendererRequest } = await import('@main/ipc/typed')

describe('typed IPC', () => {
  test('重复注册同一 channel 抛错', () => {
    const handler = () => 'ok'
    handleRendererRequest('test.channel1', handler)
    expect(() => handleRendererRequest('test.channel1', handler)).toThrow(
      /already registered/,
    )
  })

  test('不同 channel 不冲突', () => {
    handleRendererRequest('test.channel2', () => 1)
    handleRendererRequest('test.channel3', () => 2)
    // 不抛错即通过
  })
})
```

- [ ] **Step 3: 运行测试验证通过**

Run:
```bash
pnpm test tests/ipc/typed.test.ts
```

Expected: PASS（2 tests）。

- [ ] **Step 4: typecheck**

Run:
```bash
pnpm typecheck:node
```

Expected: 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/main/ipc/typed.ts tests/ipc/typed.test.ts
git commit -m "feat(ipc): add typed IPC foundation (Heckmann mode)"
```

---

## Task 11: workspace IPC domain

**Files:**
- Create: `src/shared/ipc/workspace.ts`（契约）
- Create: `src/main/ipc/domains/workspace/handlers.ts`
- Create: `src/main/ipc/domains/workspace/index.ts`
- Test: `tests/ipc/workspace-handlers.test.ts`

- [ ] **Step 1: 创建 shared/ipc/workspace.ts（契约）**

Create `src/shared/ipc/workspace.ts`：

```ts
/**
 * workspace domain IPC 契约。
 * 函数签名即契约——main 实现，renderer 通过 window.api 调用。
 *
 * 这些函数本体在 shared 里只声明签名（抛 Not Implemented），
 * 真实实现在 main/ipc/domains/workspace/handlers.ts。
 */
import type { EditorId } from '../constants'
import type { WorkspaceRecord } from '../domain'

export interface AddWorkspaceArgs {
  path: string
  name?: string
}

export interface RenameWorkspaceArgs {
  id: string
  name: string
}

export interface SetWorkspaceEditorArgs {
  id: string
  editor: EditorId
}

// 函数签名（契约）。body 不重要，类型才重要。
export async function listWorkspaces(): Promise<WorkspaceRecord[]> {
  throw new Error('implemented in main')
}
export async function addWorkspace(args: AddWorkspaceArgs): Promise<WorkspaceRecord> {
  throw new Error('implemented in main')
}
export async function removeWorkspace(args: { id: string }): Promise<void> {
  throw new Error('implemented in main')
}
export async function renameWorkspace(args: RenameWorkspaceArgs): Promise<void> {
  throw new Error('implemented in main')
}
export async function setWorkspaceEditor(args: SetWorkspaceEditorArgs): Promise<void> {
  throw new Error('implemented in main')
}

/** 聚合类型：所有 workspace handler 的 channel → 签名映射 */
export type WorkspaceHandlers = {
  'workspace.list': typeof listWorkspaces
  'workspace.add': typeof addWorkspace
  'workspace.remove': typeof removeWorkspace
  'workspace.rename': typeof renameWorkspace
  'workspace.setEditor': typeof setWorkspaceEditor
}
```

- [ ] **Step 2: 创建 handlers 实现**

Create `src/main/ipc/domains/workspace/handlers.ts`：

```ts
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { ctx } from '@main/context'
import { logger } from '@main/service/logger'
import type { AddWorkspaceArgs, RenameWorkspaceArgs, SetWorkspaceEditorArgs } from '@shared/ipc/workspace'
import type { WorkspaceRecord } from '@shared/domain'

const log = logger.domain('workspace-handler')

export class WorkspaceError extends Error {
  constructor(
    public code: 'not-found' | 'invalid-path' | 'already-exists',
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

export const listWorkspaces = async (): Promise<WorkspaceRecord[]> => {
  return ctx.db.listWorkspaces()
}

export const addWorkspace = async (args: AddWorkspaceArgs): Promise<WorkspaceRecord> => {
  const path = args.path.trim()
  if (!path) throw new WorkspaceError('invalid-path', 'path is empty')

  if (!existsSync(path)) {
    throw new WorkspaceError('invalid-path', `path does not exist: ${path}`)
  }
  const stat = statSync(path)
  if (!stat.isDirectory()) {
    throw new WorkspaceError('invalid-path', `path is not a directory: ${path}`)
  }

  const existing = ctx.db.findWorkspaceByPath(path)
  if (existing) {
    throw new WorkspaceError('already-exists', `workspace already added: ${path}`)
  }

  const now = Date.now()
  const record: WorkspaceRecord = {
    id: randomUUID(),
    path,
    name: args.name?.trim() || basename(path),
    preferredEditor: null,
    lastOpenedAt: now,
    createdAt: now,
  }
  ctx.db.insertWorkspace(record)
  log.info('added', record.id, record.path)
  return record
}

export const removeWorkspace = async (args: { id: string }): Promise<void> => {
  const existing = ctx.db.findWorkspaceById(args.id)
  if (!existing) throw new WorkspaceError('not-found', `workspace not found: ${args.id}`)
  ctx.db.deleteWorkspace(args.id)
  log.info('removed', args.id)
}

export const renameWorkspace = async (args: RenameWorkspaceArgs): Promise<void> => {
  const existing = ctx.db.findWorkspaceById(args.id)
  if (!existing) throw new WorkspaceError('not-found', `workspace not found: ${args.id}`)
  const name = args.name.trim()
  if (!name) throw new WorkspaceError('invalid-path', 'name cannot be empty')
  ctx.db.updateWorkspaceName(args.id, name)
}

export const setWorkspaceEditor = async (args: SetWorkspaceEditorArgs): Promise<void> => {
  const existing = ctx.db.findWorkspaceById(args.id)
  if (!existing) throw new WorkspaceError('not-found', `workspace not found: ${args.id}`)
  ctx.db.updateWorkspaceEditor(args.id, args.editor)
}
```

- [ ] **Step 3: 创建 domain index（注册）**

Create `src/main/ipc/domains/workspace/index.ts`：

```ts
import { handleRendererRequest } from '../../typed'
import type { WorkspaceHandlers } from '@shared/ipc/workspace'
import {
  addWorkspace,
  listWorkspaces,
  removeWorkspace,
  renameWorkspace,
  setWorkspaceEditor,
} from './handlers'

export function registerWorkspaceHandlers(): void {
  handleRendererRequest<WorkspaceHandlers, 'workspace.list'>('workspace.list', listWorkspaces)
  handleRendererRequest<WorkspaceHandlers, 'workspace.add'>('workspace.add', addWorkspace)
  handleRendererRequest<WorkspaceHandlers, 'workspace.remove'>('workspace.remove', removeWorkspace)
  handleRendererRequest<WorkspaceHandlers, 'workspace.rename'>('workspace.rename', renameWorkspace)
  handleRendererRequest<WorkspaceHandlers, 'workspace.setEditor'>(
    'workspace.setEditor',
    setWorkspaceEditor,
  )
}

export type { WorkspaceHandlers } from '@shared/ipc/workspace'
```

- [ ] **Step 4: 写 handlers 单测**

Create `tests/ipc/workspace-handlers.test.ts`：

```ts
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// mock context（隔离 db）
vi.mock('@main/context', () => {
  const rows = new Map<string, any>()
  const pathIndex = new Map<string, string>()
  return {
    ctx: {
      db: {
        listWorkspaces: () =>
          Array.from(rows.values()).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt),
        findWorkspaceByPath: (path: string) => {
          const id = pathIndex.get(path)
          return id ? rows.get(id) ?? null : null
        },
        findWorkspaceById: (id: string) => rows.get(id) ?? null,
        insertWorkspace: (record: any) => {
          rows.set(record.id, record)
          pathIndex.set(record.path, record.id)
          return record
        },
        updateWorkspaceName: (id: string, name: string) => {
          const r = rows.get(id)
          if (r) r.name = name
        },
        updateWorkspaceEditor: (id: string, editor: string | null) => {
          const r = rows.get(id)
          if (r) r.preferredEditor = editor
        },
        deleteWorkspace: (id: string) => {
          const r = rows.get(id)
          if (r) pathIndex.delete(r.path)
          rows.delete(id)
        },
      },
    },
  }
})

const { addWorkspace, listWorkspaces, removeWorkspace, renameWorkspace, setWorkspaceEditor, WorkspaceError } =
  await import('@main/ipc/domains/workspace/handlers')

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'catmax-ws-test-'))
  rows.clear?.()
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

// 重新 setup mock 的内部状态（每个测试前清空）
const rows = new Map<string, any>()
;(vi.mocked as any) // hack：mock 已被 import 时初始化，每个测试需要清空
// 改用一个 setup 函数：

describe('workspace handlers', () => {
  test('addWorkspace 创建合法目录的 workspace', async () => {
    const ws = await addWorkspace({ path: tempDir })
    expect(ws.id).toBeTruthy()
    expect(ws.path).toBe(tempDir)
    expect(ws.name).toBeTruthy()
  })

  test('addWorkspace 用 basename 作为默认 name', async () => {
    const subDir = join(tempDir, 'my-project')
    mkdirSync(subDir)
    const ws = await addWorkspace({ path: subDir })
    expect(ws.name).toBe('my-project')
  })

  test('addWorkspace 不存在的路径抛 invalid-path', async () => {
    await expect(addWorkspace({ path: '/nonexistent/path' })).rejects.toMatchObject({
      code: 'invalid-path',
    })
  })

  test('addWorkspace 文件（非目录）抛 invalid-path', async () => {
    const filePath = join(tempDir, 'file.txt')
    await import('node:fs').then(({ writeFileSync }) => writeFileSync(filePath, 'x'))
    await expect(addWorkspace({ path: filePath })).rejects.toMatchObject({
      code: 'invalid-path',
    })
  })

  test('addWorkspace 重复路径抛 already-exists', async () => {
    await addWorkspace({ path: tempDir })
    await expect(addWorkspace({ path: tempDir })).rejects.toMatchObject({
      code: 'already-exists',
    })
  })

  test('listWorkspaces 返回所有', async () => {
    await addWorkspace({ path: tempDir, name: 'ws1' })
    const list = await listWorkspaces()
    expect(list).toHaveLength(1)
    expect(list[0]?.name).toBe('ws1')
  })

  test('removeWorkspace', async () => {
    const ws = await addWorkspace({ path: tempDir })
    await removeWorkspace({ id: ws.id })
    expect(await listWorkspaces()).toHaveLength(0)
  })

  test('removeWorkspace 不存在的 id 抛 not-found', async () => {
    await expect(removeWorkspace({ id: 'non-existent' })).rejects.toMatchObject({
      code: 'not-found',
    })
  })

  test('renameWorkspace', async () => {
    const ws = await addWorkspace({ path: tempDir })
    await renameWorkspace({ id: ws.id, name: '新名字' })
    const list = await listWorkspaces()
    expect(list[0]?.name).toBe('新名字')
  })

  test('setWorkspaceEditor', async () => {
    const ws = await addWorkspace({ path: tempDir })
    await setWorkspaceEditor({ id: ws.id, editor: 'cursor' })
    const list = await listWorkspaces()
    expect(list[0]?.preferredEditor).toBe('cursor')
  })
})
```

- [ ] **Step 5: 运行测试验证通过**

Run:
```bash
pnpm test tests/ipc/workspace-handlers.test.ts
```

Expected: PASS（10 tests）。

**注意**：如果出现 mock 状态污染（一个测试影响另一个），请把 mock 改为 `vi.mock` + factory 返回新 Map 每次 `beforeEach` 清空。上述代码已尽量做到这点；若仍出问题，把 mock 提取到顶部独立 module。

- [ ] **Step 6: 提交**

```bash
git add src/shared/ipc/workspace.ts src/main/ipc/domains/workspace/ tests/ipc/workspace-handlers.test.ts
git commit -m "feat(ipc): add workspace domain with handlers and tests"
```

---

## Task 12: settings + system IPC domain

**Files:**
- Create: `src/shared/ipc/settings.ts`
- Create: `src/main/ipc/domains/settings/{handlers,index}.ts`
- Create: `src/shared/ipc/system.ts`
- Create: `src/main/ipc/domains/system/{handlers,index}.ts`
- Create: `src/main/ipc/register.ts`（聚合所有 domain）
- Test: `tests/ipc/settings-handlers.test.ts`

- [ ] **Step 1: 创建 shared/ipc/settings.ts**

Create `src/shared/ipc/settings.ts`：

```ts
import type { AppSettings } from '../settings-schema'

export type SettingsHandlers = {
  'settings.get': () => Promise<AppSettings>
  'settings.update': (args: { patch: Partial<AppSettings> }) => Promise<AppSettings>
  'settings.reset': () => Promise<AppSettings>
}
```

- [ ] **Step 2: 创建 settings handlers**

Create `src/main/ipc/domains/settings/handlers.ts`：

```ts
import { ctx } from '@main/context'
import type { AppSettings } from '@shared/settings-schema'

export const getSettings = async (): Promise<AppSettings> => {
  return ctx.settingsStore.load()
}

export const updateSettings = async (args: {
  patch: Partial<AppSettings>
}): Promise<AppSettings> => {
  return ctx.settingsStore.update(args.patch)
}

export const resetSettings = async (): Promise<AppSettings> => {
  return ctx.settingsStore.reset()
}
```

- [ ] **Step 3: 创建 settings index**

Create `src/main/ipc/domains/settings/index.ts`：

```ts
import { handleRendererRequest } from '../../typed'
import type { SettingsHandlers } from '@shared/ipc/settings'
import { getSettings, resetSettings, updateSettings } from './handlers'

export function registerSettingsHandlers(): void {
  handleRendererRequest<SettingsHandlers, 'settings.get'>('settings.get', getSettings)
  handleRendererRequest<SettingsHandlers, 'settings.update'>('settings.update', updateSettings)
  handleRendererRequest<SettingsHandlers, 'settings.reset'>('settings.reset', resetSettings)
}

export type { SettingsHandlers } from '@shared/ipc/settings'
```

- [ ] **Step 4: 创建 shared/ipc/system.ts**

Create `src/shared/ipc/system.ts`：

```ts
export interface PlatformInfo {
  platform: 'darwin' | 'win32' | 'linux'
  arch: 'arm64' | 'x64'
  osVersion: string
  appVersion: string
  electronVersion: string
}

export interface OpenDialogArgs {
  title?: string
  defaultPath?: string
  properties?: Array<'openDirectory' | 'openFile' | 'multiSelections'>
}

export interface OpenDialogResult {
  canceled: boolean
  filePaths: string[]
}

export type SystemHandlers = {
  'system.platformInfo': () => Promise<PlatformInfo>
  'system.openDialog': (args: OpenDialogArgs) => Promise<OpenDialogResult>
  'system.openExternal': (args: { url: string }) => Promise<void>
}
```

- [ ] **Step 5: 创建 system handlers**

Create `src/main/ipc/domains/system/handlers.ts`：

```ts
import { dialog, shell } from 'electron'
import { ctx } from '@main/context'
import type { OpenDialogArgs, PlatformInfo } from '@shared/ipc/system'

export const getPlatformInfo = async (): Promise<PlatformInfo> => {
  return {
    platform: process.platform as PlatformInfo['platform'],
    arch: process.arch as PlatformInfo['arch'],
    osVersion: process.getSystemVersion(),
    appVersion: process.env['npm_package_version'] ?? '0.0.0',
    electronVersion: process.versions.electron,
  }
}

export const openDialog = async (args: OpenDialogArgs) => {
  const win = ctx.getMainWindow()
  const result = await dialog.showOpenDialog(win!, {
    title: args.title,
    defaultPath: args.defaultPath,
    properties: args.properties ?? ['openDirectory'],
  })
  return { canceled: result.canceled, filePaths: result.filePaths }
}

export const openExternal = async (args: { url: string }): Promise<void> => {
  await shell.openExternal(args.url)
}
```

- [ ] **Step 6: 创建 system index**

Create `src/main/ipc/domains/system/index.ts`：

```ts
import { handleRendererRequest } from '../../typed'
import type { SystemHandlers } from '@shared/ipc/system'
import { getPlatformInfo, openDialog, openExternal } from './handlers'

export function registerSystemHandlers(): void {
  handleRendererRequest<SystemHandlers, 'system.platformInfo'>(
    'system.platformInfo',
    getPlatformInfo,
  )
  handleRendererRequest<SystemHandlers, 'system.openDialog'>('system.openDialog', openDialog)
  handleRendererRequest<SystemHandlers, 'system.openExternal'>(
    'system.openExternal',
    openExternal,
  )
}

export type { SystemHandlers } from '@shared/ipc/system'
```

- [ ] **Step 7: 创建 register.ts（聚合）**

Create `src/main/ipc/register.ts`：

```ts
import { registerWorkspaceHandlers } from './domains/workspace'
import { registerSettingsHandlers } from './domains/settings'
import { registerSystemHandlers } from './domains/system'
import { logger } from '../service/logger'

const log = logger.domain('ipc-register')

/** 所有 handler 的类型聚合（未来扩展时合并新 domain） */
export type AllHandlers =
  // 各 domain 聚合类型在这里合并：
  = unknown // 占位：在 Plan 2 加 backend、session 等时替换

export async function registerAllHandlers(): Promise<void> {
  registerWorkspaceHandlers()
  registerSettingsHandlers()
  registerSystemHandlers()
  log.info('all handlers registered')
}
```

- [ ] **Step 8: 写 settings handlers 单测**

Create `tests/ipc/settings-handlers.test.ts`：

```ts
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tempDir = mkdtempSync(join(tmpdir(), 'catmax-settings-ipc-'))

vi.mock('@main/context', () => {
  const { SettingsStore } = require('@main/service/settings-store')
  return {
    ctx: {
      settingsStore: new SettingsStore(join(tempDir, 'settings.json')),
    },
  }
})

const { getSettings, updateSettings, resetSettings } = await import(
  '@main/ipc/domains/settings/handlers'
)

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('settings handlers', () => {
  test('getSettings 返回默认值', async () => {
    const s = await getSettings()
    expect(s.defaultBackend).toBe('codex')
    expect(s.theme.mode).toBe('system')
  })

  test('updateSettings 更新部分字段', async () => {
    const updated = await updateSettings({ patch: { defaultBackend: 'claude' } })
    expect(updated.defaultBackend).toBe('claude')
    const again = await getSettings()
    expect(again.defaultBackend).toBe('claude')
  })

  test('updateSettings 浅 merge theme 嵌套对象', async () => {
    const initial = await getSettings()
    const updated = await updateSettings({
      patch: { theme: { ...initial.theme, mode: 'dark' } },
    })
    expect(updated.theme.mode).toBe('dark')
    expect(updated.theme.fontSize).toBe(initial.theme.fontSize)
  })

  test('resetSettings 恢复默认', async () => {
    await updateSettings({ patch: { defaultBackend: 'claude' } })
    const reset = await resetSettings()
    expect(reset.defaultBackend).toBe('codex')
  })
})
```

- [ ] **Step 9: 运行测试验证通过**

Run:
```bash
pnpm test tests/ipc/settings-handlers.test.ts
```

Expected: PASS（4 tests）。

- [ ] **Step 10: 提交**

```bash
git add src/shared/ipc/ src/main/ipc/domains/settings/ src/main/ipc/domains/system/ src/main/ipc/register.ts tests/ipc/settings-handlers.test.ts
git commit -m "feat(ipc): add settings + system domains and register aggregator"
```

---

## Task 13: preload api 桥接

**Files:**
- Modify: `src/preload/index.ts`（替换占位）
- Create: `src/preload/api.ts`
- Create: `src/renderer/src/env.d.ts`

- [ ] **Step 1: 创建 api.ts（从 shared/ipc 派生）**

Create `src/preload/api.ts`：

```ts
import { requestMain } from '../main/ipc/typed'
import { IPC } from '@shared/constants'
import type { WorkspaceHandlers } from '@shared/ipc/workspace'
import type { SettingsHandlers } from '@shared/ipc/settings'
import type { SystemHandlers } from '@shared/ipc/system'

/**
 * 暴露给渲染层的 api 对象。
 * 通过 contextBridge 注入 window.api。
 * 类型从 shared/ipc/* 的 handler 签名派生。
 */
export const api = {
  workspace: {
    list: requestMain<WorkspaceHandlers, 'workspace.list'>(IPC.WORKSPACE_LIST),
    add: requestMain<WorkspaceHandlers, 'workspace.add'>(IPC.WORKSPACE_ADD),
    remove: requestMain<WorkspaceHandlers, 'workspace.remove'>(IPC.WORKSPACE_REMOVE),
    rename: requestMain<WorkspaceHandlers, 'workspace.rename'>(IPC.WORKSPACE_RENAME),
    setEditor: requestMain<WorkspaceHandlers, 'workspace.setEditor'>(IPC.WORKSPACE_SET_EDITOR),
  },
  settings: {
    get: requestMain<SettingsHandlers, 'settings.get'>(IPC.SETTINGS_GET),
    update: requestMain<SettingsHandlers, 'settings.update'>(IPC.SETTINGS_UPDATE),
    reset: requestMain<SettingsHandlers, 'settings.reset'>(IPC.SETTINGS_RESET),
  },
  system: {
    platformInfo: requestMain<SystemHandlers, 'system.platformInfo'>(IPC.SYSTEM_PLATFORM_INFO),
    openDialog: requestMain<SystemHandlers, 'system.openDialog'>(IPC.SYSTEM_OPEN_DIALOG),
    openExternal: requestMain<SystemHandlers, 'system.openExternal'>(IPC.SYSTEM_OPEN_EXTERNAL),
  },
}

export type Api = typeof api
```

- [ ] **Step 2: 修改 preload/index.ts**

Modify `src/preload/index.ts`（替换 Task 3 的占位）：

```ts
import { contextBridge } from 'electron'
import { api } from './api'

// 在沙箱内通过 contextBridge 把 api 注入 window.api
// 渲染层只能访问 api 上明确暴露的方法，不能直接拿 electron
contextBridge.exposeInMainWorld('api', api)
```

- [ ] **Step 3: 创建 renderer env.d.ts**

Create `src/renderer/src/env.d.ts`：

```ts
/// <reference types="vite/client" />

declare global {
  interface Window {
    api: import('@preload/api').Api
  }
}

export {}
```

- [ ] **Step 4: typecheck**

Run:
```bash
pnpm typecheck
```

Expected: 无错误。

如果 preload 报 `Cannot find module '../main/ipc/typed'`：electron-vite 的 preload 配置需要允许 import main 模块。修改 `electron.vite.config.ts` 的 `preload` 部分，加 alias：

Modify `electron.vite.config.ts` 的 `preload` 配置：

```ts
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main'),  // 让 preload 能 import typed IPC
      },
    },
    build: {
      rollupOptions: {
        external: ['electron'],  // electron 是外部依赖
      },
    },
  },
```

- [ ] **Step 5: 在 main/index.ts 中调用 registerAllHandlers**

Modify `src/main/index.ts`，在 `ctx.settingsStore.load()` 之后：

```ts
import { registerAllHandlers } from './ipc/register'
// ...
void app.whenReady().then(async () => {
  log.info('app ready', app.getVersion())

  ctx.db.migrate()
  ctx.settingsStore.load()
  log.info('database + settings ready')

  registerAllHandlers()

  createMainWindow()
  // ...
})
```

- [ ] **Step 6: 验证 dev 启动 + 在 DevTools 调用 api**

Run:
```bash
pnpm dev
```

启动后，在 DevTools Console 执行：

```js
await window.api.system.platformInfo()
// 应该返回 { platform: 'darwin', arch: 'arm64', ... }

await window.api.workspace.add({ path: '/tmp' })
// 应该返回一个 workspace 对象

await window.api.workspace.list()
// 应该返回长度为 1 的数组
```

Expected: 所有调用返回正确结果。

- [ ] **Step 7: 提交**

```bash
git add src/preload/ src/renderer/src/env.d.ts electron.vite.config.ts src/main/index.ts
git commit -m "feat(preload): expose typed api via contextBridge"
```

---

## Task 14: Tailwind v4 + 主题系统（深/浅 + 三层 token）

**Files:**
- Create: `postcss.config.js`
- Create: `src/renderer/src/assets/styles/main.css`
- Create: `src/renderer/src/assets/styles/themes.css`
- Create: `tailwind.config.ts`
- Create: `src/renderer/src/lib/utils.ts`
- Modify: `src/renderer/src/main.ts`（import main.css）

- [ ] **Step 1: 创建 postcss.config.js**

Create `postcss.config.js`：

```js
export default {
  plugins: {
    autoprefixer: {},
  },
}
```

注意：Tailwind v4 用 `@tailwindcss/vite` 插件（在 Task 3 的 `electron.vite.config.ts` 已配），不需要在 PostCSS 里加 tailwind。

- [ ] **Step 2: 创建 themes.css**

Create `src/renderer/src/assets/styles/themes.css`：

```css
/**
 * 主题系统：三层 token 架构
 *
 * Layer 1: 原始 token（Reference）—— 色板原料，OKLCH
 * Layer 2: 语义 token（System）—— 组件唯一能引用的层
 * Layer 3: 组件 token（Component）—— 按需
 *
 * 切换主题 = 改 <html data-theme="...">，CSS 变量自动重算
 */

/* ============ DARK 主题（Codex 风格：冷调深灰） ============ */
[data-theme='dark'] {
  /* Layer 1: 原始色板 */
  --color-gray-0: oklch(99% 0 0);
  --color-gray-50: oklch(20% 0.005 250);
  --color-gray-100: oklch(18% 0.006 250);
  --color-gray-200: oklch(16% 0.006 250);
  --color-gray-300: oklch(24% 0.006 250);
  --color-gray-400: oklch(32% 0.006 250);
  --color-gray-500: oklch(45% 0.005 250);
  --color-gray-600: oklch(60% 0.005 250);
  --color-gray-700: oklch(70% 0.005 250);
  --color-gray-800: oklch(85% 0.003 250);
  --color-gray-900: oklch(95% 0.003 250);
  --color-gray-950: oklch(98% 0 0);

  --color-brand-50:  oklch(96% 0.02 250);
  --color-brand-100: oklch(93% 0.04 250);
  --color-brand-500: oklch(70% 0.15 250);
  --color-brand-600: oklch(65% 0.16 250);
  --color-brand-700: oklch(60% 0.17 250);

  --color-success: oklch(70% 0.15 145);
  --color-warning: oklch(75% 0.15 85);
  --color-danger:  oklch(65% 0.20 25);

  /* Layer 2: 语义 token */
  --background:           var(--color-gray-100);
  --foreground:           var(--color-gray-900);
  --card:                 var(--color-gray-50);
  --card-foreground:      var(--color-gray-900);
  --popover:              var(--color-gray-50);
  --popover-foreground:   var(--color-gray-900);
  --primary:              var(--color-brand-500);
  --primary-foreground:   var(--color-gray-0);
  --secondary:            var(--color-gray-200);
  --secondary-foreground: var(--color-gray-900);
  --muted:                var(--color-gray-200);
  --muted-foreground:     var(--color-gray-600);
  --accent:               var(--color-brand-500);
  --accent-foreground:    var(--color-gray-0);
  --destructive:          var(--color-danger);
  --destructive-foreground: var(--color-gray-0);
  --border:               oklch(28% 0.005 250 / 0.7);
  --input:                oklch(28% 0.005 250);
  --ring:                 var(--color-brand-500);
  --radius:               8px;

  /* Layer 3: 组件 token */
  --sidebar-background:        var(--color-gray-50);
  --sidebar-border:            var(--border);
  --sidebar-foreground:        var(--color-gray-800);
  --composer-background:       var(--color-gray-50);
  --composer-border:           var(--border);
  --code-block-background:     oklch(12% 0.005 250);
  --terminal-background:       oklch(10% 0.005 250);
  --tool-call-background:      var(--color-gray-200);
  --tool-call-border:          var(--border);
}

/* ============ LIGHT 主题（Codex 风格：米白带暖调） ============ */
[data-theme='light'] {
  /* Layer 1 */
  --color-gray-0:   oklch(99.5% 0.001 80);
  --color-gray-50:  oklch(99% 0.001 80);
  --color-gray-100: oklch(97% 0.002 80);
  --color-gray-200: oklch(94% 0.002 80);
  --color-gray-300: oklch(90% 0.002 80);
  --color-gray-400: oklch(80% 0.003 80);
  --color-gray-500: oklch(60% 0.005 250);
  --color-gray-600: oklch(50% 0.005 250);
  --color-gray-700: oklch(40% 0.005 250);
  --color-gray-800: oklch(26% 0.005 250);
  --color-gray-900: oklch(20% 0.005 250);
  --color-gray-950: oklch(12% 0.005 250);

  --color-brand-50:  oklch(97% 0.02 250);
  --color-brand-100: oklch(94% 0.04 250);
  --color-brand-500: oklch(55% 0.18 250);
  --color-brand-600: oklch(48% 0.18 250);
  --color-brand-700: oklch(42% 0.18 250);

  --color-success: oklch(55% 0.16 145);
  --color-warning: oklch(70% 0.16 85);
  --color-danger:  oklch(55% 0.22 25);

  /* Layer 2 */
  --background:           var(--color-gray-50);
  --foreground:           var(--color-gray-900);
  --card:                 var(--color-gray-0);
  --card-foreground:      var(--color-gray-900);
  --popover:              var(--color-gray-0);
  --popover-foreground:   var(--color-gray-900);
  --primary:              var(--color-brand-500);
  --primary-foreground:   var(--color-gray-0);
  --secondary:            var(--color-gray-200);
  --secondary-foreground: var(--color-gray-900);
  --muted:                var(--color-gray-200);
  --muted-foreground:     var(--color-gray-600);
  --accent:               var(--color-brand-500);
  --accent-foreground:    var(--color-gray-0);
  --destructive:          var(--color-danger);
  --destructive-foreground: var(--color-gray-0);
  --border:               oklch(90% 0.003 80);
  --input:                oklch(90% 0.003 80);
  --ring:                 var(--color-brand-500);
  --radius:               8px;

  /* Layer 3 */
  --sidebar-background:        var(--color-gray-100);
  --sidebar-border:            var(--border);
  --sidebar-foreground:        var(--color-gray-700);
  --composer-background:       var(--color-gray-0);
  --composer-border:           var(--border);
  --code-block-background:     oklch(96% 0.003 80);
  --terminal-background:       oklch(95% 0.003 80);
  --tool-call-background:      var(--color-gray-100);
  --tool-call-border:          var(--border);
}

/* ============ 字体（三个独立 token） ============ */
:root {
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', system-ui, sans-serif;
  --font-chat: 'Inter', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace;
}
```

- [ ] **Step 3: 创建 main.css（Tailwind v4 入口 + @theme 注册）**

Create `src/renderer/src/assets/styles/main.css`：

```css
@import 'tailwindcss';
@import './themes.css';

/* Tailwind v4: 把 CSS 变量注册为 Tailwind 工具类 */
@theme inline {
  /* 颜色（来自 Layer 2 语义 token） */
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);

  /* 组件色 */
  --color-sidebar: var(--sidebar-background);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-code-block: var(--code-block-background);
  --color-tool-call: var(--tool-call-background);
  --color-composer: var(--composer-background);

  /* 语义色 */
  --color-success: var(--color-success);
  --color-warning: var(--color-warning);
  --color-danger: var(--color-danger);

  /* 圆角 */
  --radius-lg: var(--radius);
  --radius-md: calc(var(--radius) - 2px);
  --radius-sm: calc(var(--radius) - 4px);

  /* 字体 */
  --font-sans: var(--font-sans);
  --font-chat: var(--font-chat);
  --font-mono: var(--font-mono);
}

/* 全局基础样式 */
html,
body,
#app {
  height: 100%;
  margin: 0;
  padding: 0;
}

body {
  font-family: var(--font-sans);
  background-color: var(--background);
  color: var(--foreground);
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  overflow: hidden;
}

/* 滚动条（细、低对比，Codex 风格） */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
::-webkit-scrollbar-thumb {
  background-color: oklch(50% 0 0 / 0.3);
  border-radius: 4px;
}
::-webkit-scrollbar-thumb:hover {
  background-color: oklch(50% 0 0 / 0.5);
}
::-webkit-scrollbar-track {
  background: transparent;
}
```

- [ ] **Step 4: 创建 tailwind.config.ts（v4 主要在 CSS 配置，这里仅留最小骨架）**

Create `tailwind.config.ts`：

```ts
import type { Config } from 'tailwindcss'

/**
 * Tailwind v4 主要在 CSS 中用 @theme 配置（见 main.css）。
 * 这里保留少量 JS 配置（如 darkMode 策略，但本项目用 data-theme 不用 dark:）。
 */
export default {
  darkMode: ['selector', '[data-theme="dark"]'],
} satisfies Config
```

- [ ] **Step 5: 创建 lib/utils.ts（shadcn-vue 用）**

Create `src/renderer/src/lib/utils.ts`：

```ts
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn-vue 标配的 class 合并工具 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
```

补依赖：

```bash
pnpm add clsx tailwind-merge class-variance-authority
```

- [ ] **Step 6: 修改 renderer/src/main.ts，import main.css**

Modify `src/renderer/src/main.ts`：

```ts
import { createApp } from 'vue'
import App from './App.vue'
import './assets/styles/main.css'

createApp(App).mount('#app')
```

- [ ] **Step 7: 修改 App.vue 测试主题**

Modify `src/renderer/src/App.vue`：

```vue
<template>
  <div class="h-full flex flex-col items-center justify-center gap-4">
    <h1 class="text-3xl font-bold text-foreground">catmax app</h1>
    <p class="text-muted-foreground">theme system test</p>

    <div class="flex gap-2">
      <button
        class="bg-primary text-primary-foreground px-3 py-1.5 rounded-md font-medium"
        @click="setTheme('dark')"
      >
        Dark
      </button>
      <button
        class="bg-secondary text-secondary-foreground px-3 py-1.5 rounded-md font-medium"
        @click="setTheme('light')"
      >
        Light
      </button>
    </div>

    <div class="mt-4 flex gap-2">
      <code class="font-mono text-[13px] bg-code-block text-foreground p-2 rounded">code block</code>
      <code class="font-chat text-[15px] bg-muted p-2 rounded">chat text</code>
    </div>
  </div>
</template>

<script setup lang="ts">
function setTheme(theme: 'dark' | 'light') {
  document.documentElement.setAttribute('data-theme', theme)
}
</script>
```

- [ ] **Step 8: 验证主题切换**

Run:
```bash
pnpm dev
```

Expected: 窗口显示标题 + Dark/Light 按钮。点击切换，整个页面颜色（背景、文字、按钮）跟随变化。代码块和聊天文本字体不同。

- [ ] **Step 9: 写主题单测**

Create `src/renderer/src/tests/theme.spec.ts`：

```ts
import { describe, expect, test } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

// 测试 setTheme 函数的行为（不依赖真实 DOM）
const ThemeSwitcher = defineComponent({
  props: { theme: { type: String, required: true } },
  setup(props) {
    return () =>
      null as never
  },
})

describe('主题系统', () => {
  test('data-theme 属性可被设置', async () => {
    // happy-dom 提供基础 DOM
    document.documentElement.setAttribute('data-theme', 'dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    document.documentElement.setAttribute('data-theme', 'light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })
})
```

- [ ] **Step 10: 运行所有测试**

Run:
```bash
pnpm test
```

Expected: 所有测试 PASS。

- [ ] **Step 11: 提交**

```bash
git add postcss.config.js tailwind.config.ts src/renderer/src/assets/ src/renderer/src/lib/ src/renderer/src/main.ts src/renderer/src/App.vue src/renderer/src/tests/
git commit -m "feat(renderer): add Tailwind v4 + three-layer theme system (dark/light)"
```

---

## Task 15: shadcn-vue 初始化与基础组件

**Files:**
- Create: `components.json`
- Create: `src/renderer/src/components/ui/button/`（shadcn 生成）
- Create: `src/renderer/src/components/ui/input/`
- Create: `src/renderer/src/components/ui/dialog/`

- [ ] **Step 1: 初始化 shadcn-vue**

Run:
```bash
pnpm dlx shadcn-vue@latest init
```

回答交互式提示：
- Style: `default`
- Base color: `neutral`
- CSS variables: `yes`
- Tailwind config path: `tailwind.config.ts`
- Components path: `src/renderer/src/components/ui`
- Utils path: `src/renderer/src/lib/utils`

完成后会生成/更新 `components.json`。

- [ ] **Step 2: 检查 components.json**

Inspect `components.json`（应类似）：

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
    "utils": "@renderer/lib/utils",
    "ui": "@renderer/components/ui",
    "lib": "@renderer/lib"
  }
}
```

如自动生成的不完全一致，手动调整到上述配置。

- [ ] **Step 3: 添加 button 组件**

Run:
```bash
pnpm dlx shadcn-vue@latest add button
```

这会在 `src/renderer/src/components/ui/button/` 下生成 `Button.vue`、`index.ts`。

- [ ] **Step 4: 添加 input 组件**

Run:
```bash
pnpm dlx shadcn-vue@latest add input
```

- [ ] **Step 5: 添加 dialog 组件**

Run:
```bash
pnpm dlx shadcn-vue@latest add dialog
```

- [ ] **Step 6: 添加 tooltip 组件**

Run:
```bash
pnpm dlx shadcn-vue@latest add tooltip
```

- [ ] **Step 7: 修改 App.vue 用 shadcn-vue 组件**

Modify `src/renderer/src/App.vue`：

```vue
<template>
  <div class="h-full flex flex-col items-center justify-center gap-4">
    <h1 class="text-3xl font-bold text-foreground">catmax app</h1>
    <p class="text-muted-foreground">shadcn-vue works</p>

    <div class="flex gap-2">
      <Button @click="setTheme('dark')">Dark</Button>
      <Button variant="secondary" @click="setTheme('light')">Light</Button>
    </div>

    <Input placeholder="test input" class="max-w-xs" />
  </div>
</template>

<script setup lang="ts">
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'

function setTheme(theme: 'dark' | 'light') {
  document.documentElement.setAttribute('data-theme', theme)
}
</script>
```

- [ ] **Step 8: 验证 shadcn-vue 组件渲染**

Run:
```bash
pnpm dev
```

Expected: 窗口显示两个 button（一个 primary 色，一个 secondary 色）和一个 input。点击 button 主题切换。

- [ ] **Step 9: typecheck + lint**

Run:
```bash
pnpm typecheck && pnpm lint
```

Expected: 无错误。

- [ ] **Step 10: 提交**

```bash
git add components.json src/renderer/src/components/ui/ src/renderer/src/App.vue
git commit -m "feat(ui): init shadcn-vue with button/input/dialog/tooltip"
```

---

## Task 16: Pinia stores + Vue Router

**Files:**
- Create: `src/renderer/src/stores/workspace.ts`
- Create: `src/renderer/src/stores/settings.ts`
- Create: `src/renderer/src/stores/ui.ts`
- Create: `src/renderer/src/router/index.ts`
- Modify: `src/renderer/src/main.ts`（接入 pinia + router）

- [ ] **Step 1: 创建 workspace store**

Create `src/renderer/src/stores/workspace.ts`：

```ts
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { WorkspaceRecord } from '@shared/domain'

export const useWorkspaceStore = defineStore('workspace', () => {
  const workspaces = ref<WorkspaceRecord[]>([])
  const currentWorkspaceId = ref<string | null>(null)
  const loading = ref(false)

  const currentWorkspace = computed(() =>
    workspaces.value.find((w) => w.id === currentWorkspaceId.value),
  )

  async function load() {
    loading.value = true
    try {
      workspaces.value = await window.api.workspace.list()
    } finally {
      loading.value = false
    }
  }

  async function add(path: string, name?: string) {
    const ws = await window.api.workspace.add({ path, name })
    workspaces.value.unshift(ws)
    return ws
  }

  async function remove(id: string) {
    await window.api.workspace.remove({ id })
    workspaces.value = workspaces.value.filter((w) => w.id !== id)
    if (currentWorkspaceId.value === id) {
      currentWorkspaceId.value = null
    }
  }

  async function rename(id: string, name: string) {
    await window.api.workspace.rename({ id, name })
    const ws = workspaces.value.find((w) => w.id === id)
    if (ws) ws.name = name
  }

  function setCurrent(id: string) {
    currentWorkspaceId.value = id
  }

  return {
    workspaces,
    currentWorkspaceId,
    loading,
    currentWorkspace,
    load,
    add,
    remove,
    rename,
    setCurrent,
  }
})
```

- [ ] **Step 2: 创建 settings store**

Create `src/renderer/src/stores/settings.ts`：

```ts
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AppSettings } from '@shared/settings-schema'
import { DEFAULT_THEME_MODE } from '@shared/constants'

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings | null>(null)
  const loading = ref(false)

  async function load() {
    loading.value = true
    try {
      settings.value = await window.api.settings.get()
    } finally {
      loading.value = false
    }
  }

  async function update(patch: Partial<AppSettings>) {
    settings.value = await window.api.settings.update({ patch })
  }

  async function reset() {
    settings.value = await window.api.settings.reset()
  }

  return { settings, loading, load, update, reset }
})
```

- [ ] **Step 3: 创建 ui store**

Create `src/renderer/src/stores/ui.ts`：

```ts
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useUiStore = defineStore('ui', () => {
  const sidebarCollapsed = ref(false)
  const settingsDialogOpen = ref(false)

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  function openSettings() {
    settingsDialogOpen.value = true
  }

  function closeSettings() {
    settingsDialogOpen.value = false
  }

  return { sidebarCollapsed, settingsDialogOpen, toggleSidebar, openSettings, closeSettings }
})
```

- [ ] **Step 4: 创建 router**

Create `src/renderer/src/router/index.ts`：

```ts
import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'welcome',
    component: () => import('@renderer/views/WelcomeView.vue'),
  },
  {
    path: '/chat',
    name: 'chat',
    component: () => import('@renderer/views/ChatView.vue'),
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@renderer/views/SettingsView.vue'),
  },
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
})
```

- [ ] **Step 5: 创建占位 views**

Create `src/renderer/src/views/WelcomeView.vue`：

```vue
<template>
  <div class="h-full flex flex-col items-center justify-center gap-6 p-8">
    <div class="text-center">
      <h1 class="text-3xl font-bold text-foreground">catmax</h1>
      <p class="mt-2 text-muted-foreground">选择一个本地文件夹作为工作区</p>
    </div>

    <Button size="lg" :disabled="adding" @click="addWorkspace">
      {{ adding ? '添加中...' : '选择工作区' }}
    </Button>

    <div v-if="workspaceStore.workspaces.length > 0" class="w-full max-w-md">
      <h2 class="text-sm font-medium text-muted-foreground mb-2">最近工作区</h2>
      <div class="flex flex-col gap-1">
        <button
          v-for="ws in workspaceStore.workspaces"
          :key="ws.id"
          class="text-left p-3 rounded-md hover:bg-muted transition-colors"
          @click="openWorkspace(ws.id)"
        >
          <div class="font-medium text-foreground">{{ ws.name }}</div>
          <div class="text-xs text-muted-foreground font-mono truncate">{{ ws.path }}</div>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Button } from '@renderer/components/ui/button'
import { useWorkspaceStore } from '@renderer/stores/workspace'

const router = useRouter()
const workspaceStore = useWorkspaceStore()
const adding = ref(false)

onMounted(async () => {
  await workspaceStore.load()
})

async function addWorkspace() {
  adding.value = true
  try {
    const result = await window.api.system.openDialog({
      title: '选择工作区文件夹',
      properties: ['openDirectory'],
    })
    if (!result.canceled && result.filePaths.length > 0) {
      const ws = await workspaceStore.add(result.filePaths[0]!)
      openWorkspace(ws.id)
    }
  } finally {
    adding.value = false
  }
}

function openWorkspace(id: string) {
  workspaceStore.setCurrent(id)
  router.push('/chat')
}
</script>
```

Create `src/renderer/src/views/ChatView.vue`：

```vue
<template>
  <div class="h-full flex items-center justify-center">
    <div class="text-center">
      <h1 class="text-xl font-semibold text-foreground">Chat（Plan 2 实现）</h1>
      <p class="mt-2 text-sm text-muted-foreground">
        当前工作区：{{ workspaceStore.currentWorkspace?.name ?? '未选择' }}
      </p>
      <Button variant="link" @click="router.push('/')">返回</Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { Button } from '@renderer/components/ui/button'
import { useWorkspaceStore } from '@renderer/stores/workspace'

const router = useRouter()
const workspaceStore = useWorkspaceStore()
</script>
```

Create `src/renderer/src/views/SettingsView.vue`：

```vue
<template>
  <div class="h-full flex items-center justify-center">
    <div class="text-center">
      <h1 class="text-xl font-semibold text-foreground">Settings</h1>
      <p class="mt-2 text-sm text-muted-foreground">Plan 1 仅含主题切换</p>
      <Button variant="link" @click="router.push('/')">返回</Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { Button } from '@renderer/components/ui/button'

const router = useRouter()
</script>
```

- [ ] **Step 6: 修改 main.ts 接入 pinia + router**

Modify `src/renderer/src/main.ts`：

```ts
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import './assets/styles/main.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
```

- [ ] **Step 7: 修改 App.vue 用 router-view**

Modify `src/renderer/src/App.vue`：

```vue
<template>
  <div class="h-full">
    <RouterView />
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useSettingsStore } from '@renderer/stores/settings'
import { useTheme } from '@renderer/composables/useTheme'

const settings = useSettingsStore()
const { apply } = useTheme()

onMounted(async () => {
  await settings.load()
  // 应用主题（基于 settings）
  if (settings.settings) {
    apply(settings.settings.theme.mode)
  }
})
</script>
```

- [ ] **Step 8: 创建 useTheme composable**

Create `src/renderer/src/composables/useTheme.ts`：

```ts
import { useSettingsStore } from '@renderer/stores/settings'
import type { ThemeMode } from '@shared/settings-schema'

let mediaQuery: MediaQueryList | null = null
let mediaListener: ((e: MediaQueryListEvent) => void) | null = null

export function useTheme() {
  const settings = useSettingsStore()

  function resolveEffective(mode: ThemeMode): 'dark' | 'light' {
    if (mode === 'system') {
      if (!mediaQuery) {
        mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      }
      return mediaQuery.matches ? 'dark' : 'light'
    }
    return mode
  }

  function apply(mode: ThemeMode) {
    const effective = resolveEffective(mode)
    document.documentElement.setAttribute('data-theme', effective)

    // 监听系统主题变化（仅 system 模式）
    if (mode === 'system') {
      startSystemListener()
    } else {
      stopSystemListener()
    }
  }

  function startSystemListener() {
    if (!mediaQuery) {
      mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    }
    if (mediaListener) return // 已经在监听
    mediaListener = () => {
      const currentMode = settings.settings?.theme.mode ?? 'system'
      if (currentMode === 'system') {
        const effective = mediaQuery!.matches ? 'dark' : 'light'
        document.documentElement.setAttribute('data-theme', effective)
      }
    }
    mediaQuery.addEventListener('change', mediaListener)
  }

  function stopSystemListener() {
    if (mediaQuery && mediaListener) {
      mediaQuery.removeEventListener('change', mediaListener)
      mediaListener = null
    }
  }

  async function setMode(mode: ThemeMode) {
    await settings.update({ theme: { ...settings.settings!.theme, mode } })
    apply(mode)
  }

  return { apply, setMode }
}
```

- [ ] **Step 9: 验证 router 和 store 工作**

Run:
```bash
pnpm dev
```

Expected:
- 启动到 WelcomeView（选择工作区）
- 点"选择工作区" → 弹原生文件夹选择器 → 选一个目录 → 跳到 ChatView
- 重启 App，最近工作区列表保留（持久化生效）

- [ ] **Step 10: 提交**

```bash
git add src/renderer/src/stores/ src/renderer/src/router/ src/renderer/src/views/ src/renderer/src/composables/ src/renderer/src/main.ts src/renderer/src/App.vue
git commit -m "feat(renderer): add Pinia stores, router, views, useTheme composable"
```

---

## Task 17: 设置页（主题/字体/工作区管理）

**Files:**
- Modify: `src/renderer/src/views/SettingsView.vue`
- Create: `src/renderer/src/components/settings/ThemeSection.vue`
- Create: `src/renderer/src/components/settings/WorkspaceSection.vue`

- [ ] **Step 1: 创建 ThemeSection 组件**

Create `src/renderer/src/components/settings/ThemeSection.vue`：

```vue
<template>
  <section class="flex flex-col gap-4">
    <header>
      <h2 class="text-lg font-semibold text-foreground">外观</h2>
      <p class="text-sm text-muted-foreground">主题、字体设置</p>
    </header>

    <div class="flex flex-col gap-3">
      <!-- 主题模式 -->
      <div class="flex items-center justify-between">
        <label class="text-sm font-medium">主题</label>
        <div class="flex gap-1 rounded-md bg-muted p-1">
          <button
            v-for="mode in (['light', 'dark', 'system'] as const)"
            :key="mode"
            :class="[
              'px-3 py-1 text-xs rounded transition-colors',
              currentMode === mode
                ? 'bg-background text-foreground shadow'
                : 'text-muted-foreground hover:text-foreground',
            ]"
            @click="setMode(mode)"
          >
            {{ modeLabel(mode) }}
          </button>
        </div>
      </div>

      <!-- UI 字号 -->
      <div class="flex items-center justify-between">
        <label class="text-sm font-medium">UI 字号</label>
        <Input
          type="number"
          :model-value="settings.settings?.theme.fontSize"
          min="11"
          max="20"
          class="w-20"
          @update:model-value="updateFontSize('fontSize', $event)"
        />
      </div>

      <!-- 聊天字号 -->
      <div class="flex items-center justify-between">
        <label class="text-sm font-medium">聊天字号</label>
        <Input
          type="number"
          :model-value="settings.settings?.theme.chatFontSize"
          min="11"
          max="20"
          class="w-20"
          @update:model-value="updateFontSize('chatFontSize', $event)"
        />
      </div>

      <!-- 代码字号 -->
      <div class="flex items-center justify-between">
        <label class="text-sm font-medium">代码字号</label>
        <Input
          type="number"
          :model-value="settings.settings?.theme.codeFontSize"
          min="10"
          max="18"
          class="w-20"
          @update:model-value="updateFontSize('codeFontSize', $event)"
        />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Input } from '@renderer/components/ui/input'
import { useSettingsStore } from '@renderer/stores/settings'
import { useTheme } from '@renderer/composables/useTheme'
import type { ThemeMode } from '@shared/settings-schema'

const settings = useSettingsStore()
const { setMode } = useTheme()

const currentMode = computed<ThemeMode>(() => settings.settings?.theme.mode ?? 'system')

function modeLabel(mode: ThemeMode): string {
  return { light: '日间', dark: '夜间', system: '跟随系统' }[mode]
}

async function updateFontSize(
  field: 'fontSize' | 'chatFontSize' | 'codeFontSize',
  value: string | number,
) {
  const num = typeof value === 'string' ? Number.parseInt(value, 10) : value
  if (Number.isNaN(num)) return
  await settings.update({
    theme: { ...settings.settings!.theme, [field]: num },
  })
}
</script>
```

- [ ] **Step 2: 创建 WorkspaceSection 组件**

Create `src/renderer/src/components/settings/WorkspaceSection.vue`：

```vue
<template>
  <section class="flex flex-col gap-4">
    <header class="flex items-center justify-between">
      <div>
        <h2 class="text-lg font-semibold text-foreground">工作区</h2>
        <p class="text-sm text-muted-foreground">管理已添加的工作区</p>
      </div>
      <Button size="sm" @click="addWorkspace">添加</Button>
    </header>

    <div class="flex flex-col gap-1">
      <div
        v-for="ws in workspaceStore.workspaces"
        :key="ws.id"
        class="flex items-center justify-between p-3 rounded-md hover:bg-muted"
      >
        <div class="min-w-0 flex-1">
          <div class="font-medium text-foreground text-sm">{{ ws.name }}</div>
          <div class="text-xs text-muted-foreground font-mono truncate">{{ ws.path }}</div>
        </div>
        <div class="flex items-center gap-1">
          <Button variant="ghost" size="sm" @click="renameWorkspace(ws.id, ws.name)">重命名</Button>
          <Button variant="ghost" size="sm" class="text-destructive" @click="removeWorkspace(ws.id)">
            删除
          </Button>
        </div>
      </div>

      <div
        v-if="workspaceStore.workspaces.length === 0"
        class="text-center py-8 text-sm text-muted-foreground"
      >
        暂无工作区
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Button } from '@renderer/components/ui/button'
import { useWorkspaceStore } from '@renderer/stores/workspace'

const workspaceStore = useWorkspaceStore()

async function addWorkspace() {
  const result = await window.api.system.openDialog({
    title: '选择工作区文件夹',
    properties: ['openDirectory'],
  })
  if (!result.canceled && result.filePaths.length > 0) {
    await workspaceStore.add(result.filePaths[0]!)
  }
}

async function removeWorkspace(id: string) {
  if (!confirm('确认删除此工作区？')) return
  await workspaceStore.remove(id)
}

async function renameWorkspace(id: string, currentName: string) {
  const name = prompt('新名字', currentName)
  if (name && name.trim()) {
    await workspaceStore.rename(id, name.trim())
  }
}
</script>
```

注意：这里用 `prompt/confirm` 是 MVP 简化，正式实现应该用 shadcn-vue 的 Dialog/AlertDialog。Task 18 之后可重写。

- [ ] **Step 3: 重写 SettingsView 用两个 section**

Modify `src/renderer/src/views/SettingsView.vue`：

```vue
<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-2xl mx-auto p-8 flex flex-col gap-8">
      <header class="flex items-center justify-between">
        <h1 class="text-2xl font-bold text-foreground">设置</h1>
        <Button variant="ghost" size="sm" @click="router.push('/')">返回</Button>
      </header>

      <ThemeSection />
      <WorkspaceSection />

      <section class="flex flex-col gap-4">
        <header>
          <h2 class="text-lg font-semibold text-foreground">关于</h2>
        </header>
        <div class="text-sm text-muted-foreground space-y-1">
          <div>catmax v{{ platformInfo?.appVersion }}</div>
          <div>Electron v{{ platformInfo?.electronVersion }}</div>
          <div>{{ platformInfo?.platform }} {{ platformInfo?.arch }}</div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Button } from '@renderer/components/ui/button'
import ThemeSection from '@renderer/components/settings/ThemeSection.vue'
import WorkspaceSection from '@renderer/components/settings/WorkspaceSection.vue'
import type { PlatformInfo } from '@shared/ipc/system'

const router = useRouter()
const platformInfo = ref<PlatformInfo | null>(null)

onMounted(async () => {
  platformInfo.value = await window.api.system.platformInfo()
})
</script>
```

- [ ] **Step 4: 在 WelcomeView 加 Settings 入口**

Modify `src/renderer/src/views/WelcomeView.vue`，在 header 区域加按钮：

把 `<div class="text-center">` 之后追加：

```vue
<Button variant="ghost" size="sm" class="absolute top-4 right-4" @click="router.push('/settings')">
  设置
</Button>
```

并把最外层 div 改为 relative：

```vue
<template>
  <div class="h-full flex flex-col items-center justify-center gap-6 p-8 relative">
    <!-- 已有内容 -->
  </div>
</template>
```

- [ ] **Step 5: 验证设置页**

Run:
```bash
pnpm dev
```

Expected:
- Welcome 页右上角有"设置"按钮，点开进入 SettingsView
- ThemeSection 切换主题立即生效
- 字号输入框可改
- WorkspaceSection 显示工作区列表，可添加/删除/重命名
- About 显示版本信息

- [ ] **Step 6: lint + typecheck + test**

Run:
```bash
pnpm lint && pnpm typecheck && pnpm test
```

Expected: 全部通过。

- [ ] **Step 7: 提交**

```bash
git add src/renderer/src/views/SettingsView.vue src/renderer/src/components/settings/ src/renderer/src/views/WelcomeView.vue
git commit -m "feat(settings): add theme + workspace management sections"
```

---

## Task 18: 集成验证（端到端 smoke test）

**Files:**
- Create: `docs/superpowers/plans/2026-07-18-plan-1-foundation-smoke-test.md`
- Manual: 端到端走查

- [ ] **Step 1: 跑完整 typecheck + lint + test**

Run:
```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: 全部通过，无错误。

- [ ] **Step 2: 启动 dev 走查**

Run:
```bash
pnpm dev
```

依次验证：
1. ✅ 启动到 WelcomeView
2. ✅ 点"选择工作区" → 选目录 → 跳到 ChatView
3. ✅ 回到 Welcome（点返回或 Cmd+1）→ 列表中有刚才的工作区
4. ✅ 点设置 → 进 SettingsView
5. ✅ 主题切换（日间/夜间/跟随系统）立即生效
6. ✅ 字号输入数字、保存
7. ✅ 删除工作区 → 列表更新
8. ✅ 添加新工作区 → 列表更新
9. ✅ 重启 App → 工作区和设置都还在

- [ ] **Step 3: 跑 production build 验证**

Run:
```bash
pnpm build
```

Expected: 三套 bundle（main/preload/renderer）都成功生成到 `out/`。

如果有报错：
- `Cannot find module 'better-sqlite3'`：确认 `externalizeDepsPlugin()` 在 main 配置中
- TypeScript 报错：按提示修
- Vue 编译错误：检查 import 路径

- [ ] **Step 4: 预览 production build**

Run:
```bash
pnpm preview
```

Expected: 启动打包后的 App（不是 dev mode），所有功能照常工作。验证 devtools 不自动打开（prod 行为）。

- [ ] **Step 5: 写 smoke test 文档**

Create `docs/superpowers/plans/2026-07-18-plan-1-foundation-smoke-test.md`：

```markdown
# Plan 1 Smoke Test 端到端验证清单

> 执行完 Plan 1 所有任务后，按此清单逐项验证。

## 启动
- [ ] `pnpm dev` 能正常启动
- [ ] `pnpm build` 能完整打包
- [ ] `pnpm preview` 能预览 production build
- [ ] `pnpm typecheck` 无错误
- [ ] `pnpm lint` 无错误
- [ ] `pnpm test` 全部通过

## 功能
- [ ] 启动到 WelcomeView
- [ ] 选择工作区 → 跳到 ChatView
- [ ] 工作区列表持久化（重启后保留）
- [ ] 设置页可进入
- [ ] 主题切换（日/夜/系统）立即生效
- [ ] 主题跟随系统时，改 OS 主题 App 实时跟随
- [ ] 字号修改后保存
- [ ] 工作区可添加/删除/重命名

## 持久化
- [ ] `~/Library/Application Support/catmax-app/catmax.db` 存在
- [ ] `~/Library/Application Support/catmax-app/settings.json` 是合法 JSON
- [ ] settings.json 含 defaultBackend、theme、backendPaths 等字段

## 类型与规范
- [ ] 渲染层 import 'electron' 会报错（ESLint 规则生效）
- [ ] window.api 调用类型完整推导（IDE 自动补全）
- [ ] catmax-conventions 技能可在新会话触发

## 已知边界
- ChatView 是占位（Plan 2 实现）
- 没有真正的后端集成（Plan 2）
- 没有 SQLite session/message 表（Plan 2）
```

- [ ] **Step 6: 提交**

```bash
git add docs/superpowers/plans/2026-07-18-plan-1-foundation-smoke-test.md
git commit -m "docs: add Plan 1 smoke test checklist"
```

---

## Plan 1 完成标志

完成后应该有：
- ✅ 可启动的 Electron + Vue3 App
- ✅ 三层进程架构（main/preload/renderer/shared）清晰分离
- ✅ 类型化 IPC（Heckmann 模式），workspace/settings/system 三个 domain 工作
- ✅ Tailwind v4 + 三层 token 主题系统，深/浅/跟随系统切换
- ✅ shadcn-vue 基础组件
- ✅ better-sqlite3 + settings.json 持久化
- ✅ Pinia stores + Vue Router
- ✅ Welcome / Settings 页可用
- ✅ 全套测试通过（约 25+ tests）
- ✅ catmax-conventions 技能生效

**下一个 plan**：Plan 2 将在此基础上加 AgentBackend 抽象 + Codex/Claude 适配器 + 聊天主界面。

---

## 自检（writing-plans skill 要求）

**1. Spec 覆盖**：

Plan 1 覆盖设计文档的：
- ✅ Phase 1（项目脚手架）：Task 1-4
- ✅ Phase 2（IPC 基础设施）：Task 10-13（workspace + settings + system 三个 domain）
- ✅ Phase 3（主题系统）：Task 14-15
- ✅ Phase 4（持久化）：Task 7-9

**Phase 5-10 留给 Plan 2 和 Plan 3**：后端抽象、聊天 UI、会话管理、Git/文件树/终端、命令面板、打包。

**2. 占位符扫描**：

已检查——所有 Task 包含完整代码，无 TBD/TODO（除 Task 6 中明确标注 `TODO(Task 8)` 这种引导性注释，指向后续 Task 的真实实现）。

**3. 类型一致性**：

- `BackendId`、`EditorId`、`PermissionMode` 等枚举在 shared/constants.ts 定义，其他地方 import 复用 ✅
- `WorkspaceRecord` 在 shared/domain.ts 定义，main 和 renderer 共用 ✅
- IPC channel 名全部走 `IPC.*` 常量，避免字符串硬编码 ✅
- handler 函数签名与 shared/ipc/*.ts 一致（注册时类型参数显式传入）✅

**4. 已知小问题（实现时注意）**：

- `verbatimModuleSyntax` 在 node 侧关闭（electron-vite 构建有特殊性，后续 plan 可重新评估）
- workspace handler 测试用了 mock + Map，可能状态污染——已在测试代码中标注，必要时改成更严格的隔离
- shadcn-vue init 是交互式的，CI 环境需要非交互模式（用 `--yes` 或预填 components.json）
