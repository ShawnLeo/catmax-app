# Unified Skill Center 测试报告

- 日期：2026-08-02
- 范围：当前工作区未提交实现，对照 `docs/superpowers/specs/2026-08-02-unified-skill-center-design.md`
- 结论：核心服务层和隔离临时工作区闭环基本可用；本轮补齐了项目迁移的 Git exclude，并完成 Electron IPC 级验收。仍缺完整鼠标设置页流程和真实后端下一轮会话验证。

## 已执行验证

| 项目 | 结果 | 说明 |
|---|---|---|
| `pnpm typecheck` | 通过 | main/preload/renderer 类型检查均通过 |
| 技能专项 Vitest | 通过 | 3 个文件、36 个测试全部通过 |
| 目标 ESLint | 通过 | 技能相关新增/修改文件无 lint 错误 |
| `git diff --check` | 通过 | 无空白/补丁格式问题 |
| 全量 `pnpm test` | 未通过（环境/既有问题） | 816/843 通过；27 个数据库测试受 better-sqlite3 Node ABI 不匹配影响，另有 1 个既有 pty 时序测试失败 |
| Chrome DevTools | 通过（Electron IPC） | 已连接 Electron 真 renderer，读取 workspace/skills snapshot，并执行镜像、开关、迁移、删除调用 |

早期直接访问 Vite renderer 页面时没有 Electron preload，只能做壳层观察；本轮已改为连接 Electron 真 renderer，因此后续 IPC 结果才作为有效证据。

### Chrome DevTools 第二轮（真实 Electron target）

- 通过 CDP 连接到实际 Electron renderer：`http://localhost:5173/#/`（DevTools 服务端口 `9223`），不是 Vite 预览页。
- 在 DevTools Console 的 Live Expression 中确认：`window.api` 存在，且暴露了 `workspace/settings/system/backend/session/git/fs/pty/skills` 等 IPC 域；`window.api.skills.list` 和 `window.api.system.platformInfo` 均为 `function`。
- DevTools Console 普通输入受到 Chrome 的 self-XSS 粘贴保护，因此使用 Live Expression 完成检查。通过 Promise 回写页面标题，成功读取 workspace、skills snapshot，并执行 mirror、setEnabled、migrate、remove 等 IPC。
- 注意：Live Expression 会持续重算；未加一次性保护的删除表达式会在第一次成功后再次执行并显示“找不到技能”。这属于验收脚本副作用，不是应用业务结果；后续写操作均使用一次性 guard。

### Electron 真窗口清单执行结果（本次复验）

本次实际启动 `pnpm dev`，通过 Chrome DevTools CDP 连接 Electron renderer，并完成了工作区前置操作：欢迎页点击最近工作区 `catmax-app` 后进入真实会话页，页面显示“新建会话”和历史会话列表。随后在 Live Expression 中直接调用 `window.api.skills.list()`，主进程日志记录：`TypeError: Cannot read properties of undefined (reading 'workspaceId')`。

这次调用没有传入应用要求的 workspace 上下文，属于验收脚本调用参数不完整，不能单独判定 `skills.list` 业务实现失败；但也说明当前没有足够的 UI/E2E 证据完成后续技能清单闭环。具体清单状态如下：

| 清单项 | 状态 | 证据/阻塞 |
|---|---|---|
| 打开含 demo 技能的工作区并在设置显示 | 部分通过 | 临时 workspace 加入成功，`skills.list({workspaceId})` 返回 `project:demo`；未通过鼠标完整进入设置页 |
| 修复可见性、软链、exclude、git clean | 通过（隔离目录） | mirror 返回 `ok:true`，两条后端软链实际创建，Git exclude 实际写入 |
| 开关、`skills-state.json`、Codex/Claude 投影一致 | 部分通过 | `setEnabled(false/true)` 均返回 `ok:true`；未抓取文件内容及真实下一轮后端对话 |
| `.claude/skills` 迁移、回链、exclude | 通过（隔离目录） | migrate 返回 `ok:true`，统一目录与原位置回链实际存在，exclude 规则存在 |
| 外部增删后聚焦自动刷新 | 代码/专项测试通过，UI 未完整复验 | 当前 store 已有 focus/visibility listener；未通过设置页鼠标流程验证视觉刷新 |
| 删除隔离性 | 通过（隔离目录） | remove 首次执行后临时技能目录及软链均被删除；重复执行的“找不到”来自 Live Expression 重算 |

因此，本次“真窗口验收”结论是：Electron 启动、CDP 连接、preload、workspace/skills IPC，以及隔离目录的镜像、开关、迁移、删除均已得到证据；仍缺完整鼠标设置页流程和真实 Codex/Claude 下一轮会话验证，整体状态为“部分通过，待补充 UI/E2E”。

## 对照方案的遗漏与本轮修复

本轮复查后确认，`skills/changed`、窗口 focus/visibility 刷新已经在当前未提交代码中实现，并有对应 Codex 专项测试；此前报告把它们列为遗漏已过时，现已更正。

### 已修复：项目级 migrate 写 `.git/info/exclude`

`migrateSkill()` 原先只重建回链，没有像 `mirrorSkill()` 一样写项目 exclude。本轮已补上 `.codex/skills/` 与 `.claude/skills/` 两条规则，并通过真实临时 Git 工作区复验迁移后软链存在、exclude 规则存在。

### P2：迁移操作缺少确认和专项回滚测试

迁移会移动用户目录并在原处重建软链，但 UI 只对删除调用 `window.confirm`；同时没有 handler 级测试覆盖 `rename` 成功、回链失败、权限失败、`.git/info/exclude` 结果。

## 建议测试方案

1. 服务层：扫描三种根目录、同名合并、全局/项目隔离、坏 frontmatter、不可读目录、软链/外部软链、镜像清单损坏、越界删除、权限失败。
2. 后端投影：Codex `skills/config/write` 的 name 选择器、失败重试/启动补推、`skills/changed` 刷新；Claude 覆盖文件合并、用户已有 `skillOverrides` 优先、无覆盖时保持路径传递。
3. IPC：逐个调用 `list/setEnabled/mirror/migrate/remove/reveal/openInEditor`，验证只接受 `<scope>:<name>`，所有变更返回新 snapshot，异常不会留下半成品。
4. 设置页：全局/项目分组、可见性徽标、修复可见性、全部修复串行、开关状态、路径/编辑器/访达按钮、不可写提示、窗口重新聚焦刷新。
5. 新建会话页：技能数量只统计当前项目已启用项；切换工作区、打开/关闭 popover、Esc/外部点击关闭、开关/删除后数量和列表同步。
6. 安全回归：全局技能不可删除；项目多根目录逐根处理；任何 location 越界则整体拒绝；用户真实目录和非受管软链不被覆盖或删除；`.gitignore` 不被修改。

## Electron 真窗口验收清单

在 Electron 窗口（而非 Chrome 直连 Vite 页面）完成以下最小闭环后再验收：

- 创建/打开一个含 `.agents/skills/demo/SKILL.md` 的工作区，设置页显示“项目技能 demo”。
- 点击“修复可见性”，确认 `.claude/skills/demo` 为软链、`.git/info/exclude` 有对应规则、`git status` 干净。
- 关闭/开启技能，确认设置页开关、`skills-state.json`、Codex RPC 和下一轮 Claude query 一致。
- 从 `.claude/skills` 真目录执行迁移，确认统一目录、原位置回链和 exclude 均正确。
- 在外部增删技能后切回窗口，确认设置页自动刷新；当前 store 已实现 focus/visibilitychange 和 `skills:changed` 补充刷新，仍建议补一条真正的鼠标 E2E。
- 删除项目技能并确认只删除当前工作区内目录/软链，不影响全局技能及软链目标。
