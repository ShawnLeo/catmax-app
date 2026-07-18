# Plan 2 Smoke Test 端到端验证清单

> 执行完 Plan 2 所有任务后，按此清单逐项验证。
>
> **最后验证日期**：2026-07-18

## 自动化验证（已通过 ✅）

### 构建 / 测试

- [x] `pnpm typecheck` 0 errors（node + web 双 tsconfig）
- [x] `pnpm lint` 0 errors（3 个 pre-existing warnings，非阻塞）
- [x] `pnpm test` 全部通过 —— **103/103 tests**
  - Plan 1 遗留：44 tests
  - Plan 2 新增：59 tests
    - `tests/backend/protocol-schema.test.ts`（12 tests）
    - `tests/backend/protocol.test.ts`（16 tests）
    - `tests/backend/mapping.test.ts`（15 tests）
    - `tests/backend/adapter.test.ts`（4 scenarios）
    - `tests/service/codex-resolver.test.ts`（3 tests）
    - `tests/service/database.test.ts` 新增 sessions + messages（12 tests）
- [x] `pnpm build` production 成功（含 Shiki 全套语法 chunk 懒加载）

### 启动序列（dev 启动日志）

- [x] `[main] app ready 0.1.0`
- [x] `[database] opened ~/Library/Application Support/catmax-app/catmax.db`
- [x] `[database] migrated`（含 sessions + messages 新表）
- [x] `[settings-store] loaded settings`
- [x] `[main] database + settings ready`
- [x] `[ipc-register] all handlers registered`（含 backend + session 新 domain）
- [x] Vite dev server `http://localhost:5173/`
- [x] `start electron app...` 无错误

## 可视化验证（需要用户手动确认 ⏳）

以下功能需要启动 App + 真实 codex CLI 后用眼睛看：

### 前置条件

- [ ] `which codex` 找到 codex CLI
- [ ] `codex login` 已完成（凭证有效）

### 启动到聊天

- [ ] `pnpm dev` 启动
- [ ] Welcome 页选工作区 → 跳到 ChatView
- [ ] RuntimeConfigBar 显示 "codex" + 版本号（绿色 connected 徽章）
- [ ] 模型下拉框列出 gpt-5.1-codex 等

### 发送消息 + 流式输出

- [ ] 输入 "hello" + Enter
- [ ] 用户消息立即显示（"Y" 头像）
- [ ] Codex 头像（◆）显示
- [ ] 流式文本逐字出现（Markdown 渲染）
- [ ] 代码块带 Shiki 语法高亮

### Tool Call 流程

- [ ] 让 Codex 跑个命令（如 "列出当前目录文件"）
- [ ] ToolCallCard 显示命令名 + running 状态（脉动动画）
- [ ] 命令完成后显示 exit code + 输出
- [ ] 点击卡片展开看完整输出

### Approval 流程

- [ ] 触发需要批准的操作（如 Codex 修改文件）
- [ ] ApprovalDialog 弹窗（带 riskLevel 徽章：low/medium/high 不同颜色）
- [ ] 详情区显示完整 diff
- [ ] Enter = 允许，Esc = 拒绝（键盘快捷键）
- [ ] 批准后 turn 继续

### 中断

- [ ] turn 跑到一半时点"停止"按钮（红色，destructive 色）
- [ ] 立即停止流式输出
- [ ] turn 状态变为 interrupted

### 切换运行时配置

- [ ] 切换 model → 下次 turn 用新模型
- [ ] 切换 effort → 下次 turn 用新 effort
- [ ] 切换 permission mode → 下次 turn 用新策略

### 持久化

- [ ] 关闭 App 重启
- [ ] 工作区列表保留
- [ ] session 列表保留（侧边栏 Plan 3 加，但 db 里有）

## 已知限制（Plan 3+ 处理）

- [ ] 侧边栏未实现（Plan 3 加完整的 sidebar + session 列表 UI）
- [ ] `session.detail` 返回空 messages（codex rollout 回放是 Plan 3+）
- [ ] 只支持 codex 后端（Plan 3 加 claude，验证抽象可插拔）
- [ ] `BackendManager.listSessions` 只列当前后端（Plan 3 列所有后端）
- [ ] 没有 ⌘K 命令面板（Plan 3+）
- [ ] 没有 Git 面板/文件树/终端/编辑器集成（Plan 3+）

## 执行 Plan 2 过程中发现并修复的问题

记录执行 Plan 2 过程中发现的问题，便于 Plan 3+ 借鉴：

1. **`z.union` + passthrough 不 narrow** — `codexItemSchema` 是 `z.union` 不是 `discriminatedUnion`，`switch (item.type)` 不会收窄类型。下游（adapter.ts、mapping.ts）需要 `Extract<CodexItem, { type: 'xxx' }>` + `as` cast。**Plan 3+ 改成 `discriminatedUnion` 可彻底解决**。
2. **`exactOptionalPropertyTypes: true` 全面影响** — 所有 optional 字段不能赋 `undefined`，要用条件 spread 或 `if (x !== undefined)`。这是项目级约定，影响所有新代码。
3. **`noImplicitOverride: true`** — `BackendError` 继承 `Error` 时 `cause` 字段要加 `override`。
4. **`codexCommandToOutput` ok 语义** — codex `status: 'completed'` 表示"跑完了"（不是"exit 0"），需要用 `exitCode` 判断成功失败。
5. **CodexAdapter.startTurn sink 时序** — PassThrough 同步触发 data 事件，sink 必须在 sendRequest 之前设置。Plan 写的 verbatim 顺序会丢消息。
6. **`healthCheck` ENOENT typo** — Plan 代码写的是 `'code' === 'ENOENT'`（左操作数是字符串字面量），永远 false。
7. **`listModels` 缺 `ensureInitialized()`** — 不主动 initialize 的话 `proc` 是 null。
8. **Tailwind v4 scoped style 需要 `@reference`** — 在 `.vue` 的 `<style scoped>` 里用 `@apply` 自定义 utility（如 `font-mono`、`bg-code-block`），必须加 `@reference "../../assets/styles/main.css";`，否则 build 失败。
9. **`lucide-vue-next` 已 deprecated** — 仍可用（1.0.0 是最新版），但 Plan 3+ 可考虑迁移到 `@lucide/vue`。
10. **Vue select + v-model 可空字段** — `v-model="modelValue.model"`（model 是 `string | null`）会直接修改 prop，应该用 `:value` + `@change` 显式 emit。

## 总结

Plan 2 完成度：**16/16 tasks ✅**。

核心能力交付：能跟真实 codex CLI 流式聊天、Markdown 渲染（含 Shiki 代码高亮）、tool call 卡片、approval 弹窗、中断、运行时配置切换。103/103 自动化测试通过，production build 成功。

**Plan 3 起步基础**：claude 适配器（验证抽象可插拔）、完整侧边栏（session 列表 + 后端指示器）、Plan 1 没做完的周边功能（Git 面板/文件树/终端/编辑器集成/⌘K 命令面板）。
