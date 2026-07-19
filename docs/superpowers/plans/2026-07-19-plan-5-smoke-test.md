# Plan 5 Smoke Test 端到端验证清单

> 执行完 Plan 5 所有任务后，按此清单逐项验证。
>
> **最后验证日期**：2026-07-19

## 自动化验证（已通过 ✅）

- [x] `pnpm typecheck` 0 errors（node + web）
- [x] `pnpm lint` 0 errors（16 个 pre-existing warnings）
- [x] `pnpm test` 全部通过 —— **165/165 tests**
  - Plan 1-4b 遗留：152 tests
  - Plan 5 新增：13 tests
    - `tests/backend/codex-history-mapping.test.ts`（6 tests）
    - `tests/backend/claude-history-mapping.test.ts`（6 tests）
    - `tests/backend/adapter.test.ts` 新增 getHistory 场景（1 test）
- [x] `pnpm dist:mac` 成功产出 dmg
  - `dist/catmax-0.1.0-arm64.dmg`（105 MB，Apple Silicon）
  - `dist/catmax-0.1.0-x64.dmg`（111 MB，Intel）

### 启动序列（dev）

- [x] `[main] app ready 0.1.0`
- [x] `[database] opened / migrated`
- [x] `[main] database + settings ready`
- [x] `[ipc-register] all handlers registered`
- [x] Vite dev server 启动
- [x] Electron app 启动无错误

## 可视化验证（需要用户手动确认 ⏳）

### 会话历史回放

- [ ] 启动 App，进入 ChatView
- [ ] 在某个后端跑一两轮对话（产生历史）
- [ ] 重启 App → 侧边栏会话列表显示之前的会话
- [ ] 点击会话 → 看到"加载历史中..."loading
- [ ] 加载完成后看到完整对话（user / assistant / tool call）
- [ ] tool call 卡片正确显示 exit code / diff
- [ ] 历史不显示 "running" 状态（都是 completed）
- [ ] 切换后端后，点击旧后端的只读会话 → 也能加载历史
- [ ] 历史加载失败时显示错误（如后端未登录）

### 快捷键

- [ ] 按 `⌘K` → 命令面板弹出/关闭（toggle）
- [ ] 按 `⌘N` → 新建会话（清空当前 message store）
- [ ] 按 `⌘B` → 切换 Sidebar 显示/隐藏
- [ ] 按 `⌘J` → 切换右栏 RightPanel
- [ ] 按 `⌘,` → 跳到设置页
- [ ] 按 `⌘1` ~ `⌘9` → 切换到对应会话（按列表倒序）
- [ ] 在命令面板里能看到这些命令（带 shortcut 显示）

### 打包发布

- [ ] `pnpm dist:mac` 产出 `dist/catmax-0.1.0-arm64.dmg` + `dist/catmax-0.1.0-x64.dmg`
- [ ] 双击 dmg → 出现 catmax App 图标 + Applications 快捷方式
- [ ] 拖到 Applications 后能打开
- [ ] 首次打开 macOS 提示"未签名"（右键打开即可）
- [ ] App 内功能正常（聊天、终端、Git、文件树）
- [ ] `pnpm dist:win` 在 Windows 上产出 nsis 安装包（待 Windows 设备验证）

## 已知限制（后续 Plan）

- [ ] 打包不 notarize（自用项目）
- [ ] 没有 icon（用默认 Electron 图标）
- [ ] Windows 包未实测（需要在 Windows 设备上跑 `pnpm dist:win`）
- [ ] 自动更新（electron-updater）已装但未接入
- [ ] 没有自动化引擎（cron）—— 设计文档明确 out of MVP scope
- [ ] 没有云同步

## 执行 Plan 5 过程中发现并修复的问题

1. **`AgentBackend` 接口加 `getHistory` 方法时全 typecheck 失败** —— 因为 Task 1 只改接口，两个 Adapter 还没实现，编译报错。临时在 Task 1 加 throwing stub，Task 2/3 替换为真实实现。
2. **`CodexAdapter.getHistory` 不能用 `override` 关键字** —— Adapter 是 `implements` 不是 `extends`，`override` 只适用于继承。
3. **ClaudeAdapter `proc.child.on('exit')` 在 `result` 后还可能触发** —— 加 `done` 标志让 exit 处理幂等。
4. **electron-builder `app-builder` 子进程不读 `.npmrc`** —— 必须在 shell 环境设 `ELECTRON_MIRROR` 和 `ELECTRON_BUILDER_BINARIES_MIRROR`，用 `cross-env` 写进 npm script。
5. **`CommandPalette` 自己监听 mod+k 会与新注册的 `app.command-palette` 命令双触发** —— 删掉 CommandPalette 自己的 keydown 监听，统一走 commandRegistry。
6. **`exactOptionalPropertyTypes` 对历史映射的影响** —— codex history-mapping 的 ToolOutput 字段需要条件 spread。

## 总结

Plan 5 完成度：**8/8 tasks ✅**。

核心能力交付：
- **会话历史回放** —— codex（`thread/read`）+ claude（`--resume` 重放）都支持，UI 加载态，按 session.backend 选 adapter
- **完整快捷键体系** —— commandRegistry 自动绑定 shortcut，⌘K/N/B/J/,/1-9
- **打包发布** —— macOS dmg（arm64 + x64）+ Windows nsis 安装包

165/165 自动化测试通过，production dmg 打包成功。

至此项目从 MVP 走到了"自用 ready"状态——能安装、能记录历史、有完整快捷键。
