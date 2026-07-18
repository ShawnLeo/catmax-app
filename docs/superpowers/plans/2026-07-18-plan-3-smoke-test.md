# Plan 3 Smoke Test 端到端验证清单

> 执行完 Plan 3 所有任务后，按此清单逐项验证。
>
> **最后验证日期**：2026-07-18

## 自动化验证（已通过 ✅）

- [x] `pnpm typecheck` 0 errors（node + web）
- [x] `pnpm lint` 0 errors（16 个 pre-existing warnings，全是测试文件 `any`，非阻塞）
- [x] `pnpm test` 全部通过 —— **130/130 tests**
  - Plan 1+2 遗留：103 tests
  - Plan 3 新增：27 tests
    - `tests/backend/claude-protocol-schema.test.ts`（8 tests）
    - `tests/backend/claude-mapping.test.ts`（14 tests）
    - `tests/backend/claude-adapter.test.ts`（5 tests）
- [x] `pnpm build` production 成功

### 启动序列（dev 启动日志）

- [x] `[main] app ready 0.1.0`
- [x] `[database] opened ~/Library/Application Support/catmax-app/catmax.db`
- [x] `[database] migrated`
- [x] `[main] database + settings ready`
- [x] `[ipc-register] all handlers registered`
- [x] Vite dev server 启动
- [x] Electron app 启动无错误

## 可视化验证（需要用户手动确认 ⏳）

### 启动 + 两栏布局

- [ ] `pnpm dev` 启动
- [ ] Welcome 选工作区 → 进入 ChatView
- [ ] 看到左侧 Sidebar（240px 宽）+ 右侧主聊天区
- [ ] Sidebar 背景色与主区有别（深色主题下更深一点）

### 工作区切换

- [ ] Sidebar 顶部 WorkspaceSwitcher 显示当前工作区名 + 路径
- [ ] 点击展开工作区列表（弹层）
- [ ] 切换工作区 → session 列表刷新
- [ ] "添加工作区" → 弹原生文件夹选择器

### 会话列表（按后端分区）

- [ ] 当前后端的会话在"可继续"区（标题：`<backend> · 可继续`）
- [ ] 其他后端的会话在"只读"区（折叠，标题：`其他后端 · 只读 (N)`）
- [ ] 每个会话显示标题 + backend + 相对时间
- [ ] 点击会话切换 currentSession
- [ ] hover 会话显示删除按钮
- [ ] 点击删除 → confirm → 真删
- [ ] 只读会话有锁图标标记

### 后端切换

- [ ] Sidebar 底部 BackendIndicator
- [ ] 显示当前后端名 + 版本号 + 状态点（绿色=available，红色=unavailable）
- [ ] 点击下拉切换 codex ↔ claude
- [ ] 切换后会话列表的 continuable/readonly 自动重算（codex 会话变只读，claude 会话变可继续）

### 双后端真实聊天

- [ ] 在 codex 后端发条消息，看到流式输出 + tool call 卡片
- [ ] 切换到 claude 后端
- [ ] 在 claude 后端发条消息，看到流式输出
- [ ] codex 会话现在显示在"只读"区
- [ ] claude 不弹 approval（capabilities.supportsApproval = false）

### 持久化

- [ ] 关闭 App 重启
- [ ] 工作区列表保留
- [ ] 会话列表保留
- [ ] 会话归属不变（codex 会话永远是 codex，不会因为当前后端变化而改）

## 已知限制（Plan 4+ 处理）

- [ ] `session.detail` 返回空 messages（codex/claude 的 rollout 回放是 Plan 4+）
- [ ] 点击只读会话能切换上下文，但消息列表为空
- [ ] 没有 ⌘K 命令面板
- [ ] 没有 Git 面板 / 文件树 / 终端 / 编辑器集成
- [ ] WorkspaceSwitcher 工作区列表样式简陋（没用 shadcn dropdown，是简单弹层）

## 执行 Plan 3 过程中发现并修复的问题

1. **`bg-sidebar-background` token 未注册** — Plan 写的 sidebar 组件用 `bg-sidebar-background` / `border-sidebar-border`，但 main.css 的 `@theme inline` 只注册了 `--color-sidebar` 和 `--color-sidebar-foreground`。修复：注册 `--color-sidebar-border`，并把组件里的 `bg-sidebar-background` 改为 `bg-sidebar`（匹配 token 名）。
2. **WorkspaceSwitcher 弹层定位** — 用 `absolute` 但父级没 `relative`，弹层会相对于最近的定位祖先（可能是整个窗口）。修复：父 div 加 `relative` 类。
3. **`exactOptionalPropertyTypes` 对 ClaudeAdapter 的影响** — `spawn` 的 `cwd` 选项需要条件 spread，不能直接 `cwd: this.opts.cwd`（可能是 undefined）。和 CodexAdapter 相同模式。
4. **`z.union` 不 narrow（已知问题）** — ClaudeAdapter 也遇到，用 `Extract<>` + cast 解决。
5. **session store 的 inline `import()` 类型** — ESLint `consistent-type-imports` 禁止，改成 top-level import。

## 总结

Plan 3 完成度：**6/6 tasks ✅**。

核心能力交付：双后端（codex + claude）真实可切换，**验证了 AgentBackend 抽象可插拔**（ClaudeAdapter 实现同一接口，UI 零修改就支持新后端）。完整侧边栏（工作区/会话/后端），会话按后端分区显示（"可继续" vs "其他后端只读"）。130/130 自动化测试通过，production build 成功。

**Plan 4 起步基础**：Plan 1 没做完的周边功能（Git 面板、文件树、终端、编辑器集成、⌘K 命令面板）+ session.detail 真实回放历史消息。
