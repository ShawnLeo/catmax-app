# Plan 4a Smoke Test 端到端验证清单

> 执行完 Plan 4a 所有任务后，按此清单逐项验证。
>
> **最后验证日期**：2026-07-18

## 自动化验证（已通过 ✅）

- [x] `pnpm typecheck` 0 errors（node + web）
- [x] `pnpm lint` 0 errors（16 个 pre-existing warnings）
- [x] `pnpm test` 全部通过 —— **148/148 tests**
  - Plan 1+2+3 遗留：130 tests
  - Plan 4a 新增：18 tests
    - `tests/service/git-service.test.ts`（3 tests，git 不可用时 skip）
    - `tests/service/file-tree.test.ts`（9 tests）
    - `tests/service/editor-launcher.test.ts`（6 tests，需 `@vitest-environment node`）
- [x] `pnpm build` production 成功

## 可视化验证（需要用户手动确认 ⏳）

### 右栏布局

- [ ] ChatView 右上角看到"切换右栏"按钮（PanelRightIcon）
- [ ] 点击按钮 → RightPanel 显示（320px 宽）
- [ ] 再次点击 → 隐藏
- [ ] RightPanel 有 Git / Files 两个 tab

### Git tab

- [ ] 非 git repo 显示提示"当前工作区不是 git repo"
- [ ] git repo 显示分支名（如 `main`）+ ↑ ahead / ↓ behind
- [ ] Staged 区显示已暂存变更（绿色 added / 黄色 modified / 红色 deleted）
- [ ] Unstaged 区显示未暂存变更
- [ ] Untracked 区显示未跟踪文件
- [ ] "最近提交" 显示 5 条 commit（hash + message + author + date）
- [ ] "刷新" 按钮工作

### Files tab

- [ ] 文件树递归显示
- [ ] 目录排前面，按名字排序
- [ ] node_modules / .git / dist 不显示
- [ ] .gitignore 中的文件不显示（如 secret.txt）
- [ ] 点击目录：展开/折叠（ChevronRight 旋转）
- [ ] 点击文件：底部出现 FilePreview
- [ ] FilePreview 显示路径 + "在编辑器中打开"按钮
- [ ] 文件内容带语法高亮（Shiki）
- [ ] 二进制文件显示"二进制文件"提示
- [ ] 大文件（>256KB）显示截断提示

### 编辑器集成

- [ ] 在 FilePreview 点"在编辑器中打开"
- [ ] VS Code（或工作区 preferredEditor）打开对应文件
- [ ] 编辑器未安装时弹 alert 错误
- [ ] 工作区设置 preferredEditor 后用对应编辑器

### 工作区切换

- [ ] 切换工作区 → git status 自动刷新
- [ ] 切换工作区 → 文件树重新加载

## 已知限制（Plan 4b / 后续）

- [ ] 文件预览不支持编辑（Shiki 只读）
- [ ] Git 面板不支持 commit/push（设计文档明确 MVP 只读）
- [ ] 文件树没有搜索功能（Plan 5+）
- [ ] 没有终端（Plan 4b）
- [ ] 没有 ⌘K 命令面板（Plan 4b）

## 执行 Plan 4a 过程中发现并修复的问题

1. **`@types/ignore` 不存在** —— `ignore` 包自带类型定义，dev dep 多余，跳过安装。
2. **file-tree.ts 语法 bug** —— plan verbatim 代码有重复 `let entries` 声明，去掉第一个。
3. **`ignore` 包对目录模式的匹配** —— `ig.ignores('build')` 对 `.gitignore` 写 `build/` 的目录模式返回 false，需要传 `build/`（带斜杠）。修复：`ig.ignores(isDirectory ? rel + '/' : rel)`。
4. **happy-dom 下 `vi.mock('node:child_process')` 无效** —— vitest 默认 happy-dom 环境，对 `node:*` 内置模块的 mock 不生效。修复：测试文件顶部加 `// @vitest-environment node` 注释切换环境。
5. **`vi.spyOn(await import(...))` 不可用** —— 不能在动态 import 后再 spy。改成 `vi.hoisted` + 顶层 `vi.mock`。
6. **`exactOptionalPropertyTypes` 多处影响** —— handler 参数传递 optional 字段时需要条件 spread。
7. **`FileTreeNode.vue` 的 `v-if` + `v-for` 冲突** —— ESLint `vue/no-use-v-if-with-v-for` 规则禁止，删掉冗余的 `v-if`（空数组 v-for 本来就不渲染）。
8. **DEFAULT_EDITOR 常量缺失** —— plan 假设 `shared/constants.ts` 有，但实际没有。补 `DEFAULT_EDITOR = 'vscode' as const satisfies EditorId`。

## 总结

Plan 4a 完成度：**8/8 tasks ✅**。

核心能力交付：Git Status 只读面板（分支/staged/unstaged/untracked/commits）、文件树（gitignore 感知、递归）、文件预览（Shiki 高亮）、编辑器集成（5 个 IDE）、右栏 RightPanel（tab 切换、可折叠）。148/148 自动化测试通过，production build 成功。

**下一阶段（Plan 4b）**：内置终端（xterm.js + node-pty）+ ⌘K 命令面板。完成后 MVP 全部 14 项能力齐备。
