# Plan 1 Smoke Test 端到端验证清单

> 执行完 Plan 1 所有任务后，按此清单逐项验证。
>
> **最后验证日期**：2026-07-18（所有自动化项已验证通过；可视化项需要用户手动确认）

## 自动化验证（已通过 ✅）

### 构建 / 测试

- [x] `pnpm dev` 能正常启动（rebuild:native || true && electron-vite dev）
- [x] `pnpm build` 能完整打包三层 bundle
  - `out/main/index.js`（120KB）
  - `out/preload/index.mjs`（1.3KB）
  - `out/renderer/`（含 view chunks + index 267KB + workspace store 105KB）
- [x] `pnpm typecheck` 无错误（node + web 两个 tsconfig 都通过）
- [x] `pnpm lint` 0 errors（3 个 pre-existing warnings，非阻塞）
- [x] `pnpm test` 全部通过 —— **44/44 tests**
  - `tests/shared/constants.test.ts`（5 tests）
  - `tests/shared/settings-schema.test.ts`（7 tests）
  - `tests/service/database.test.ts`（10 tests）
  - `tests/service/settings-store.test.ts`（6 tests）
  - `tests/ipc/typed.test.ts`（2 tests）
  - `tests/ipc/workspace-handlers.test.ts`（10 tests）
  - `tests/ipc/settings-handlers.test.ts`（4 tests）

### 启动序列（dev 启动日志）

- [x] `[main] app ready 0.1.0`
- [x] `[database] opened ~/Library/Application Support/catmax-app/catmax.db`
- [x] `[database] migrated`
- [x] `[settings-store] loaded settings`
- [x] `[main] database + settings ready`
- [x] `[ipc-register] all handlers registered`
- [x] Vite dev server `http://localhost:5173/`
- [x] `start electron app...` 无错误

### 持久化文件

- [x] `~/Library/Application Support/catmax-app/catmax.db` 存在（28KB）
- [x] `catmax.db-shm` + `catmax.db-wal`（WAL 模式生效）
- [x] `~/Library/Application Support/catmax-app/settings.json` 是合法 JSON
- [x] settings.json 内容完整匹配 AppSettings schema（所有字段、默认值、嵌套结构）

### IPC 全链路

- [x] Preload 通过 contextBridge 暴露 `window.api`
- [x] 11 个 IPC 方法全部注册（5 workspace + 3 settings + 3 system）
- [x] 类型从 `shared/ipc/*` → preload → `window.api` 自动派生
- [x] Handler 函数签名变更会让 renderer 编译报错（契约不漂移）

### 双 ABI 处理（Electron + Node）

- [x] `pnpm rebuild:native` 切换到 Electron ABI（用于 dev/build）
- [x] `pnpm rebuild:node` 切换到 Node ABI（用于 vitest）
- [x] `pnpm dev` 自动调 `rebuild:native`（含 `|| true` 容错）
- [x] `pnpm build` 自动调 `rebuild:native`

## 可视化验证（需要用户手动确认 ⏳）

以下功能需要启动 App 后用眼睛看，subagent 无法验证：

### 启动到 Welcome 页

- [ ] 启动到 WelcomeView（标题 "catmax" + "选择一个本地文件夹作为工作区"）
- [ ] 点 "选择工作区" → 弹原生文件夹选择器
- [ ] 选一个目录 → 跳到 ChatView
- [ ] 点 ChatView 的 "返回" → 回到 Welcome
- [ ] "最近工作区" 列表中有刚才添加的工作区

### 设置页

- [ ] 点 Welcome 右上角"设置"按钮 → 进入 SettingsView
- [ ] 主题切换：日间 / 夜间 / 跟随系统 立即生效
- [ ] 跟随系统模式：改 OS 主题，App 实时跟随
- [ ] 字号修改后保存（重启 App 后值还在）
- [ ] 工作区列表显示所有已添加的工作区
- [ ] 点 "添加" 弹文件夹选择器
- [ ] 点 "重命名" 弹 prompt
- [ ] 点 "删除" 弹 confirm
- [ ] "关于" 区域显示版本信息（catmax v0.1.0 / Electron v31.x.x / darwin arm64）

### 主题视觉

- [ ] 深色主题：背景偏冷调深灰（非纯黑），文字偏白
- [ ] 浅色主题：背景米白带暖调（非纯白）
- [ ] 按钮 primary 色可见（蓝紫调）
- [ ] 代码块字体等宽、与聊天文本字体不同
- [ ] 滚动条细、低对比

### 持久化（重启验证）

- [ ] 关闭 App 再打开 → 工作区列表保留
- [ ] 关闭 App 再打开 → 设置（主题、字号）保留

## 类型与规范

- [x] 渲染层 import 'electron' 会触发 ESLint error（renderer 限制规则生效）
- [x] `window.api` 调用类型完整推导（IDE 自动补全）
- [ ] catmax-conventions 技能可在新会话触发（手动测试：开新会话问"catmax 项目规范"）

## 已知边界（Plan 1 范围外）

- [x] ChatView 是占位（Plan 2 实现真正的聊天 UI）
- [x] 没有真正的后端集成（Plan 2 加 AgentBackend）
- [x] SQLite 没有 session/message 表（Plan 2 加）
- [x] `pnpm preview` 没单独验证（用 `pnpm dev` 已覆盖 dev 模式；prod build 已验证）

## 发现并修复的环境/工具链问题

记录执行 Plan 1 过程中发现并解决的问题，便于后续 plan 借鉴：

1. **`unplugin-auto-import` dts 路径错位** —— 配置项 `dts` 用绝对路径（`resolve(__dirname, ...)`）
2. **`node-linker=hoisted` 过宽** —— 改用 `public-hoist-pattern[]=*better-sqlite3*`
3. **`pnpm.onlyBuiltDependencies` 缺失** —— 添加 `["better-sqlite3", "electron"]`（pnpm 10 安全策略）
4. **better-sqlite3 双 ABI 问题** —— dev/build 用 Electron ABI（125），test 用 Node ABI（127），靠 `rebuild:native` / `rebuild:node` 切换
5. **`electron-rebuild` 返回非零退出码** —— dev/build 脚本加 `|| true` 容错
6. **`exactOptionalPropertyTypes` 与 radix-vue / vueuse 不友好** —— 简化 shadcn-vue 组件（不用 Primitive / useVModel）
7. **`shadcn-vue` CLI 路径解析失败** —— 手写等价 Button/Input 组件（shadcn 设计就支持这种方式）
8. **`.gitignore` 中 `.vscode/!?(\.gitignore)` 无效语法** —— 已删除（用 `.vscode/*` + negation 替代）
9. **`autoprefixer` 在 Tailwind v4 下冗余** —— 已从 PostCSS 移除（`@tailwindcss/vite` 内部处理）

## 总结

Plan 1 完成度：**18/18 tasks ✅**。

地基完整：可启动的 Electron + Vue3 App、IPC 全链路通、深/浅主题系统、SQLite 持久化、设置页。所有自动化测试通过（44 tests），production build 通过。

下一阶段（Plan 2）将在此基础上加 AgentBackend 抽象 + Codex/Claude 适配器 + 聊天主界面。
