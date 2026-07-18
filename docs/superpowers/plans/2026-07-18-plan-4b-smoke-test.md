# Plan 4b Smoke Test 端到端验证清单

> 执行完 Plan 4b 所有任务后，按此清单逐项验证。
>
> **最后验证日期**：2026-07-18

## 自动化验证（已通过 ✅）

- [x] `pnpm typecheck` 0 errors（node + web）
- [x] `pnpm lint` 0 errors（16 个 pre-existing warnings）
- [x] `pnpm test` 全部通过 —— **152/152 tests**
  - Plan 1+2+3+4a 遗留：148 tests
  - Plan 4b 新增：4 tests（`tests/service/pty-manager.test.ts`）
- [x] `pnpm build` production 成功（含 xterm.js + node-pty 打包）

## 可视化验证（需要用户手动确认 ⏳）

### 内置终端

- [ ] RightPanel 第三个 tab "Terminal" 可见（与 Git / Files 并列）
- [ ] 切到 Terminal → 自动创建一个终端
- [ ] 看到 shell 提示符（zsh / bash，根据系统）
- [ ] 输入 `ls` + Enter → 看到文件列表
- [ ] 输入 `pwd` + Enter → 看到当前路径
- [ ] 鼠标滚动有效
- [ ] 调整 RightPanel 宽度 → 终端列数自适应（FitAddon + ResizeObserver）
- [ ] 点 + 按钮 → 新建第二个终端
- [ ] 切换终端 tab → 数据不混（每个实例独立 xterm）
- [ ] URL 可点击（addon-web-links）
- [ ] 退出 App → 所有终端进程被清理（killAll）

### ⌘K 命令面板

- [ ] 按 ⌘K → CommandPalette 弹出（屏幕中央偏上）
- [ ] 输入框自动 focus
- [ ] 列出所有命令（按字母序）
- [ ] 输入"工作区" → 模糊匹配"添加工作区"
- [ ] ↑↓ 键选择命令
- [ ] 回车 → 触发对应 action
- [ ] Esc → 关闭
- [ ] 点击外部 → 关闭

### 默认命令集（7 个）

- [ ] "回到首页" → 跳到 Welcome
- [ ] "打开设置" → 跳到 Settings
- [ ] "添加工作区" → 弹原生文件夹选择器
- [ ] "新建会话" → 重置当前会话
- [ ] "切换到 Codex 后端" → backendStore.switchTo('codex')
- [ ] "切换到 Claude 后端" → backendStore.switchTo('claude')
- [ ] "刷新后端状态" → backendStore.refresh()

## 已知限制（Plan 5+）

- [ ] 终端不持久化（重启 App 后丢失）
- [ ] 终端没有 ANSI 颜色主题切换（用固定深色）
- [ ] ⌘K 命令的快捷键是显示用（不实际绑定，只触发 palette）
- [ ] 没有命令历史（最近用过的命令排前面）

## 执行 Plan 4b 过程中发现并修复的问题

1. **`@types/node-pty` 不存在** —— node-pty v1+ 自带类型，跳过安装。
2. **node-pty 需要 `onlyBuiltDependencies`** —— pnpm 10 默认禁用 native postinstall，需要在 package.json 加白名单（和 Plan 1 的 better-sqlite3 同样模式）。
3. **node-pty native rebuild** —— 复用 `rebuild:native` 脚本，加 `-w node-pty`。
4. **`PtyPushEvents` 必须是 `type` 不是 `interface`** —— `PushEventMap` 约束 `Record<string, unknown>`，interface 不满足（无 index signature），type alias 满足。
5. **xterm CSS 不能在 `.ts` composable 里 import** —— 移到 `main.ts`。
6. **`process.cwd()` 不能在 renderer 用** —— 违反渲染层不能调 Node 的规则。TerminalPanel 改为传空字符串，main 的 handler fallback 到 `process.cwd()`。
7. **PtyManager 测试需要 `@vitest-environment node`** —— happy-dom 下 node-pty 不能 spawn 真实 shell（和 Plan 4a 的 editor-launcher 同样教训）。
8. **`router.push()` 返回 `Promise<void | NavigationFailure | undefined>`** —— 不匹配 `() => void | Promise<void>` 签名，用 `void router.push(...)` 丢弃返回值。
9. **`exactOptionalPropertyTypes` 多处影响** —— createTerminal handler 的可选 cols/rows 用条件 spread。

## 总结

Plan 4b 完成度：**8/8 tasks ✅**。

核心能力交付：内置终端（xterm.js + node-pty，多实例、resize、web-links）+ ⌘K 命令面板（命令注册系统、模糊搜索、键盘导航、7 个默认命令）。152/152 自动化测试通过，production build 成功。

---

## 🎉 MVP 全部 14 项能力完成

至此设计文档第一章列出的 14 项 MVP 能力全部齐备：

| # | 能力 | Plan |
|---|---|---|
| 1 | Electron + Vue3 应用骨架 | Plan 1 |
| 2 | 聊天主界面（流式 + Markdown + tool call） | Plan 2 |
| 3 | 工作区模型 | Plan 1 |
| 4 | 双后端适配器（codex + claude） | Plan 2 + 3 |
| 5 | 会话持久化 | Plan 1 + 2 |
| 6 | 中断 + tool call approval | Plan 2 |
| 7 | ⌘K 命令面板 | **Plan 4b** |
| 8 | 深/浅双主题（含可扩展系统） | Plan 1 |
| 9 | macOS + Windows 双平台 | Plan 1 |
| 10 | Git Status 面板（只读） | Plan 4a |
| 11 | 文件树（只读 + 预览） | Plan 4a |
| 12 | 内置终端 | **Plan 4b** |
| 13 | 编辑器集成（5 个 IDE） | Plan 4a |
| 14 | 设置页 | Plan 1 |

**下一步**：打磨、性能优化、用户反馈驱动的新功能。
