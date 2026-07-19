# catmax-app 功能清单

> 截至 2026-07-19（Plan 5 合并后），项目已实现的全部能力详解。
>
> 每项功能含：**能做什么**、**怎么用**、**实现位置**、**已知限制**。
>
> 用于：新接手项目的快速了解 / 用户使用参考 / 后续规划的现状基线。

---

## 目录

- [一、后端与对话](#一后端与对话)
- [二、会话与历史](#二会话与历史)
- [三、工作区](#三工作区)
- [四、聊天界面](#四聊天界面)
- [五、侧边栏](#五侧边栏)
- [六、右栏面板](#六右栏面板)
- [七、终端](#七终端)
- [八、命令面板与快捷键](#八命令面板与快捷键)
- [九、主题与外观](#九主题与外观)
- [十、设置](#十设置)
- [十一、持久化](#十一持久化)
- [十二、打包发布](#十二打包发布)
- [十三、架构基础](#十三架构基础)
- [十四、测试覆盖](#十四测试覆盖)
- [未实现 / 后续规划](#未实现--后续规划)

---

## 一、后端与对话

### 1.1 双后端支持（codex + claude）

**能做什么**：
- 同时支持 OpenAI codex CLI 和 Anthropic claude code CLI
- 一键切换当前后端（Sidebar 底部下拉）
- 后端可用性自动检测（`--version` 探测）
- 后端能力差异声明（`BackendCapabilities`）

**怎么用**：
1. 装好两个 CLI 之一（或都装）：
   ```bash
   npm install -g @openai/codex    # codex
   # claude code 从 claude.ai/code 安装
   ```
2. 首次使用在终端跑 `codex login` / `claude login`（OAuth）
3. 在 App 内 Sidebar 底部 BackendIndicator 切换

**实现位置**：
- 抽象接口：`src/shared/backend/types.ts` → `AgentBackend`
- Codex 适配器：`src/main/backend/codex/adapter.ts`
- Claude 适配器：`src/main/backend/claude/adapter.ts`
- 管理器：`src/main/backend/manager.ts`

**两个后端的能力差异**（UI 据此显隐功能）：

| 能力 | codex | claude |
|---|---|---|
| 流式文本输出 | ✅ | ✅ |
| Tool call（命令/diff/MCP） | ✅ | ✅ |
| Approval 请求 | ✅ | ❌（permission-mode 自动决策） |
| 中断（Stop） | ✅ `turn/interrupt` | ✅ kill 进程 |
| Steer（中途补充输入） | ✅ `turn/steer` | ❌ |
| Thread fork | ✅ | ❌ |
| 模型选择 | ✅ `model/list` 动态 | ✅ 固定列表（sonnet/opus/haiku） |
| Effort（推理强度） | ✅ `low/medium/high` | ✅ `low/medium/high/xhigh/max` |
| Permission mode | ✅ 6 档 | ✅ 6 档 |
| 会话历史回放 | ✅ `thread/read` | ✅ `--resume` 重放 |

### 1.2 流式聊天

**能做什么**：
- 实时流式输出（边生成边显示）
- Markdown 渲染（标题、列表、链接、引用）
- Shiki 语法高亮（200+ 语言，懒加载）
- Mermaid 图表（依赖已装但渲染组件未实现）
- Reasoning（思考过程）独立块，弱化显示

**实现位置**：
- Markdown 配置：`src/renderer/src/lib/markdown.ts`
- 渲染组件：`src/renderer/src/components/chat/MarkdownView.vue`
- 事件累积：`src/renderer/src/stores/message.ts` → `applyEvent`

### 1.3 Tool Call 卡片

**能做什么**：
- 命令调用（codex `command_execution` / claude `Bash`）
- 文件编辑（codex `file_change` / claude `Edit/Write`）
- 文件读取（claude `Read/Glob/Grep`）
- MCP 工具调用（`mcp_tool_call` / `mcp__server__tool`）
- 卡片可折叠展开看完整输出（diff、命令输出）
- 状态色（running 脉动 / completed 绿 / failed 红）

**实现位置**：
- 组件：`src/renderer/src/components/chat/ToolCallCard.vue`
- codex 映射：`src/main/backend/codex/mapping.ts` → `codexItemToToolCallInfo`
- claude 映射：`src/main/backend/claude/mapping.ts` → `toolUseToInfo`

### 1.4 Approval 流程

**能做什么**（仅 codex）：
- codex 在执行需要授权的命令前弹 approval 对话框
- 显示命令/diff 详情 + 风险等级（low/medium/high）
- 三种决策：允许 / 本会话都允许 / 拒绝
- 键盘快捷键：Enter = 允许，Esc = 拒绝
- 高风险时默认焦点在"拒绝"

**实现位置**：
- 组件：`src/renderer/src/components/chat/ApprovalDialog.vue`
- 风险评估：`src/main/backend/codex/mapping.ts` → `assessRisk`

### 1.5 中断与 Steer

**能做什么**：
- 点 Composer 的"停止"按钮中断当前 turn
- codex 还支持 Steer（在 turn 跑到一半时补充说明）—— UI 未暴露按钮但接口已就绪

**实现位置**：
- 中断：`AgentBackend.interrupt()` / BackendManager 路由
- Steer：`AgentBackend.steer?()` （可选方法）

### 1.6 运行时配置

**能做什么**：
- Composer 上方 RuntimeConfigBar 实时切换：
  - 后端（codex/claude）
  - 模型（gpt-5.1-codex / claude-sonnet / ...）
  - Effort（low/medium/high/xhigh/max）
  - Permission mode（default/acceptEdits/auto/plan/dontAsk/bypassPermissions）
- 下拉选项根据当前后端 capabilities 自动裁剪

**实现位置**：
- 组件：`src/renderer/src/components/chat/RuntimeConfigBar.vue`

---

## 二、会话与历史

### 2.1 会话创建与持久化

**能做什么**：
- 第一次发消息时自动创建会话（用当前后端 + 当前工作区）
- 会话元信息存 SQLite（`sessions` 表）
- 会话内容（items）由后端自己存（codex rollout 文件 / claude session json）
- App 的 SQLite 是**索引层**，不复制全文（避免双写不一致）

**实现位置**：
- 表结构：`src/main/service/schema.sql` → `sessions` + `messages` 表
- IPC：`session.create` / `session.list` / `session.remove`
- Handler：`src/main/ipc/domains/session/handlers.ts`

### 2.2 会话归属不变

**能做什么**：
- 会话永远属于创建它的后端（`sessions.backend` 字段永久不变）
- 切换当前后端不影响已有会话的归属
- 在 codex 后端创建的会话，永远是 codex 会话
- 不能"跨后端继续聊"（必须切回原后端）

**为什么这么设计**：会话内容是后端原生格式（codex 的 JSON-RPC items / claude 的 stream-json），强行让别的后端读没意义。

### 2.3 会话列表（按后端分区）

**能做什么**：
- Sidebar 中部 SessionList 按后端分两区显示：
  - **可继续**（`continuable = session.backend === currentBackend`）—— 可点击进入并继续聊
  - **其他后端只读**（折叠）—— 可点击浏览历史但不能继续聊
- 每个会话显示：标题 / backend / 相对时间
- hover 显示删除按钮

**实现位置**：
- 计算：`src/renderer/src/stores/session.ts` → `sessionsByBackend` computed
- 组件：`src/renderer/src/components/sidebar/SessionList.vue` + `SessionItem.vue`

### 2.4 会话历史回放

**能做什么**：
- 点击侧边栏任意会话（包括其他后端的只读会话）→ 加载完整历史
- 显示"加载历史中..."loading 态
- 加载完成后看到完整对话（user / assistant / tool call 卡片）
- 历史不显示 "running" 状态（全部 completed）

**实现细节**：
- **codex**：调 `thread/read` + `includeTurns: true` 拿 turn 数组，转成 NormalizedMessage
- **claude**：spawn `claude -p --resume <id>` 进程（不发新输入），收完 stdout 重放消息后 kill 进程

**实现位置**：
- 接口：`AgentBackend.getHistory(backendThreadId)`
- codex 映射：`src/main/backend/codex/history-mapping.ts`
- claude 映射：`src/main/backend/claude/history-mapping.ts`
- BackendManager 按 `session.backend` 选 adapter（不是当前后端）

### 2.5 对账（reconcile）

**能做什么**：
- 切换工作区时、启动时调 `session.reconcile`
- 与后端当前真实会话列表对账：
  - 后端有、App 没登记 → 自动补登记
  - App 有、后端没有 → 标记 stale（不删，让用户决定）

**实现位置**：
- IPC：`session.reconcile`
- Handler：`src/main/ipc/domains/session/handlers.ts` → `reconcileSessions`

---

## 三、工作区

### 3.1 工作区管理

**能做什么**：
- 多个工作区，每个绑定一个本地文件夹作为 CWD
- Welcome 页"选择工作区"按钮弹原生文件夹选择器
- 工作区切换在 Sidebar 顶部 WorkspaceSwitcher
- 工作区持久化（重启 App 后列表保留）
- 工作区可重命名 / 删除
- 每个工作区记忆首选编辑器

**实现位置**：
- IPC：`workspace.{list,add,remove,rename,setEditor}`
- 表结构：`workspaces` 表
- Store：`src/renderer/src/stores/workspace.ts`

---

## 四、聊天界面

### 4.1 三栏布局

**能做什么**：
- 整体布局：`Sidebar (240px) | Main Chat | RightPanel (320px)`
- Sidebar 永远显示
- RightPanel 可折叠（默认折叠，按 ⌘J 切换）
- 主区随窗口大小自适应

**实现位置**：
- 主框架：`src/renderer/src/views/ChatView.vue`

### 4.2 消息流（无气泡设计）

**能做什么**：
- 借鉴 Codex 风格：无气泡，全宽布局
- 头像 + 名字（"You" / "Codex" 或 "Claude"）+ 消息内容
- 流式输出时自动滚到底部
- 空状态显示"开始新对话"提示

**实现位置**：
- 列表：`src/renderer/src/components/chat/MessageList.vue`
- 单条：`src/renderer/src/components/chat/MessageItem.vue`

### 4.3 Composer（输入区）

**能做什么**：
- 多行文本输入（Shift+Enter 换行，Enter 发送）
- 运行中显示"停止"按钮（红色，destructive）
- 后端未连接时 disabled + 提示
- 字体独立（`font-chat`，默认 Inter）

**实现位置**：
- 组件：`src/renderer/src/components/chat/Composer.vue`

---

## 五、侧边栏

### 5.1 WorkspaceSwitcher

**能做什么**：
- 显示当前工作区名 + 路径
- 点击展开工作区列表（弹层）
- 切换工作区 → 自动重新加载该工作区的会话
- "添加工作区"入口

**实现位置**：
- 组件：`src/renderer/src/components/sidebar/WorkspaceSwitcher.vue`

### 5.2 SessionList

详见 [二、会话与历史](#二会话与历史)。

### 5.3 BackendIndicator

**能做什么**：
- Sidebar 底部显示当前后端 + 版本号
- 状态点（绿色 = available / 红色 = unavailable）
- 下拉切换后端
- 右侧"设置"按钮（齿轮图标）

**实现位置**：
- 组件：`src/renderer/src/components/sidebar/BackendIndicator.vue`

---

## 六、右栏面板

### 6.1 RightPanel（tab 切换）

**能做什么**：
- 三个 tab：Git / Files / Terminal
- 当前 tab 高亮（primary 色下边框）
- Git tab 显示变更数 badge（如 `(5)`）
- 可折叠（按 ⌘J 或点右上角图标）

**实现位置**：
- 组件：`src/renderer/src/components/panel/RightPanel.vue`

### 6.2 Git 面板（只读）

**能做什么**：
- 显示当前工作区的 git status：
  - 分支名 + ↑ahead / ↓behind
  - Staged 区（绿色 added / 黄色 modified / 红色 deleted）
  - Unstaged 区
  - Untracked 区
  - 最近 5 条 commit（hash + message + author + date）
- 非 git repo 显示提示
- "刷新"按钮手动重载

**实现位置**：
- 组件：`src/renderer/src/components/panel/GitPanel.vue` + `FileChangeItem.vue`
- 服务：`src/main/service/git-service.ts`（simple-git 封装）
- IPC：`git.status`

**已知限制**：只读，不支持 commit / push / branch / merge（设计文档明确 MVP 范围）。

### 6.3 文件树（只读）

**能做什么**：
- 递归显示工作区文件
- gitignore 感知（读 `.gitignore` + 默认忽略 node_modules / .git / dist）
- 目录优先排序
- 符号链接安全处理（不递归进链接，避免循环）
- 上限 2000 条（防止超大型目录卡死）
- 点击目录展开/折叠
- 点击文件底部预览

**实现位置**：
- 组件：`src/renderer/src/components/panel/FileTree.vue` + `FileTreeNode.vue`
- 服务：`src/main/service/file-tree.ts`
- IPC：`fs.readDirectory`

### 6.4 文件预览

**能做什么**：
- Shiki 语法高亮（200+ 语言）
- 二进制文件检测（含 \0 字节）+ 友好提示
- 大文件截断（>256KB 只显示前 256KB）
- "在编辑器中打开"按钮（调工作区 preferredEditor）

**实现位置**：
- 组件：`src/renderer/src/components/panel/FilePreview.vue`
- 服务：`src/main/service/file-tree.ts` → `detectLanguage` / `isBinaryContent`
- IPC：`fs.readFilePreview`

**已知限制**：只读预览，不支持编辑（设计文档明确）。

---

## 七、终端

### 7.1 内置终端

**能做什么**：
- RightPanel 第三个 tab
- 多实例（点 + 按钮新建）
- 默认 shell（macOS: zsh，Windows: PowerShell）
- cwd = 当前工作区根目录
- xterm.js 渲染 + node-pty 后端
- 自适应 resize（FitAddon + ResizeObserver）
- URL 可点击（addon-web-links）
- 终端退出自动清理（killAll on app quit）

**实现位置**：
- 组件：`src/renderer/src/components/panel/TerminalPanel.vue`
- Composable：`src/renderer/src/composables/useTerminal.ts`
- 服务：`src/main/service/pty-manager.ts`
- IPC：`pty.{create,write,resize,kill}` + 推送 `pty:data` / `pty:exit`

**已知限制**：
- 不持久化（重启 App 后丢失）
- 没有 ANSI 颜色主题切换（固定深色）
- 没有复制粘贴快捷键（用系统默认）

---

## 八、命令面板与快捷键

### 8.1 ⌘K 命令面板

**能做什么**：
- 按 ⌘K 弹出（屏幕中央偏上）
- 模糊搜索（title + category + keywords）
- 键盘导航（↑↓ 选择 / Enter 触发 / Esc 关闭）
- 显示快捷键提示（如 `⌘N`）
- 点击外部关闭

**实现位置**：
- 组件：`src/renderer/src/components/command/CommandPalette.vue`
- 注册系统：`src/renderer/src/lib/commandRegistry.ts`
- 默认命令：`src/renderer/src/lib/commands.ts`

### 8.2 快捷键体系

**已绑定的快捷键**：

| 快捷键 | 命令 | 说明 |
|---|---|---|
| `⌘K` | app.command-palette | 打开/关闭命令面板（toggle） |
| `⌘N` | session.new | 新建会话 |
| `⌘B` | app.toggle-sidebar | 切换 Sidebar 显示 |
| `⌘J` | app.toggle-right-panel | 切换右栏 RightPanel |
| `⌘,` | app.go-settings | 打开设置 |
| `⌘1` ~ `⌘9` | session.switch-N | 切换到第 N 个最近会话 |

**实现机制**：
- `commandRegistry.register({ shortcut: 'mod+n', ... })` 时自动绑定全局 keydown
- `mod` 自动映射为 macOS 的 Cmd / 其他的 Ctrl
- unregister 时自动解绑

### 8.3 默认命令集

**已注册的 7+9 = 16 个命令**：

- **Navigation**：回到首页、打开设置
- **Workspace**：添加工作区
- **Session**：新建会话、切换到会话 1-9
- **Backend**：切换到 Codex、切换到 Claude、刷新后端状态
- **View**：切换侧边栏、切换右栏
- **App**：打开命令面板

**实现位置**：`src/renderer/src/lib/commands.ts` → `registerDefaultCommands`

---

## 九、主题与外观

### 9.1 深/浅/跟随系统

**能做什么**：
- 三档切换：日间（light）/ 夜间（dark）/ 跟随系统（system）
- 跟随系统模式实时响应 OS 主题变化
- 切换在设置页"外观"区

**实现位置**：
- 主题定义：`src/renderer/src/assets/styles/themes.css`
- Composable：`src/renderer/src/composables/useTheme.ts`
- 设置组件：`src/renderer/src/components/settings/ThemeSection.vue`

### 9.2 三层 token 架构

**设计**：
```
Layer 1: 原始 token（OKLCH 色板原料）
  --color-gray-0 ... --color-gray-950
  --color-brand-500
  --color-success / warning / danger

Layer 2: 语义 token（★ 组件唯一能引用的层）
  --background / --foreground / --primary / --muted / --border ...
  组件代码只写 bg-background / text-foreground，永远不写具体色

Layer 3: 组件 token（按需）
  --sidebar-background / --composer-background / --code-block-background
```

**为什么这么设计**：
- 改主题 = 改 CSS 变量，组件零修改
- 加新主题 = 加一段 `[data-theme="xxx"]` 块
- OKLCH 色彩空间（感知均匀，深浅色派生更自然）

### 9.3 三个独立字体

| Token | 用途 | 默认值 |
|---|---|---|
| `--font-sans` | UI（按钮、菜单、对话框） | Inter |
| `--font-chat` | 聊天消息正文 | Inter |
| `--font-mono` | 代码块、终端 | JetBrains Mono |

**实现位置**：`src/renderer/src/assets/styles/themes.css` + `main.css` 的 `@theme inline`

### 9.4 字号设置

**能做什么**：
- UI 字号（11-20px，默认 14）
- 聊天字号（11-20px，默认 15）
- 代码字号（10-18px，默认 13）
- 设置页"外观"区独立调整

---

## 十、设置

### 10.1 设置页（5 个分区）

**能做什么**：

1. **外观**：主题模式、UI/聊天/代码字号
2. **工作区**：列表管理（添加 / 重命名 / 删除 / 设首选编辑器）
3. **后端配置**（已设计，部分实现）：codex/claude CLI 路径、默认后端
4. **凭证管理**（已设计，部分实现）：API key 加密存储（safeStorage）
5. **HTTP 代理**（已设计，部分实现）：url + bypass
6. **关于**：版本信息

**实现位置**：
- 视图：`src/renderer/src/views/SettingsView.vue`
- 设置组件：`src/renderer/src/components/settings/ThemeSection.vue` + `WorkspaceSection.vue`
- Store：`src/renderer/src/stores/settings.ts`
- 持久化：`src/main/service/settings-store.ts`（settings.json + Zod）

### 10.2 设置 schema

**完整字段**（`src/shared/settings-schema.ts`）：

```ts
AppSettings = {
  defaultBackend: 'codex' | 'claude'
  backendPaths: { codex: string|null, claude: string|null }
  defaultEditor: 'vscode' | 'cursor' | 'intellij' | 'webstorm' | 'sublime'
  theme: {
    mode: 'light' | 'dark' | 'system'
    fontFamily: { sans, chat, mono }
    fontSize, chatFontSize, codeFontSize
  }
  httpProxy: { enabled, url, bypass }
  language: 'zh-CN' | 'en-US'
  sendOnEnter: boolean
  showReasoningByDefault: boolean
}
```

加载时用 Zod 严格校验（settings.json 是磁盘上的不可信输入）。

---

## 十一、持久化

### 11.1 SQLite 数据库

**位置**：
- macOS: `~/Library/Application Support/catmax-app/catmax.db`
- Windows: `%APPDATA%/catmax-app/catmax.db`

**模式**：WAL（并发读写不互斥）

**表**：
- `workspaces`：工作区列表
- `sessions`：会话索引（backend + backend_thread_id + workspace_id）
- `messages`：消息预览（前 200 字，用于搜索）
- `app_state`：key-value 单表（存 last_workspace_id / current_backend 等）

**实现位置**：`src/main/service/database.ts`

### 11.2 settings.json

**位置**：和 catmax.db 同目录

**特点**：
- JSON 格式（人可读，便于调试）
- Zod schema 校验（损坏时回退默认值 + 警告）
- 部分更新（嵌套对象浅 merge）

### 11.3 凭证加密

**能做什么**：
- API key 用 Electron `safeStorage.encryptString` 加密后存盘
- macOS: Keychain / Windows: DPAPI
- 经环境变量传子进程（不写命令行，避免进程列表泄漏）
- `getCredential` 仅在"测试连接"流程中调用，绝不推给聊天 UI

**实现位置**：`src/main/ipc/domains/credential/`（部分实现）

---

## 十二、打包发布

### 12.1 macOS dmg

**能做什么**：
- `pnpm dist:mac` 一键产出双架构 dmg：
  - `dist/catmax-0.1.0-arm64.dmg`（Apple Silicon，~105MB）
  - `dist/catmax-0.1.0-x64.dmg`（Intel，~111MB）
- DMG 含 Applications 快捷方式（拖拽安装）
- hardenedRuntime + entitlements（JIT / 库验证关闭等）

**首次打开**：macOS 会提示"未签名"（自用项目不打 notarize），右键打开即可。

### 12.2 Windows nsis

**配置就绪**：
- `pnpm dist:win` 产出 nsis 安装包
- 允许用户选安装路径（`allowToChangeInstallationDirectory`）
- 非全局安装（perMachine: false）

**注意**：需要在 Windows 设备上跑（macOS 不能交叉打 Windows 包）。

### 12.3 配置文件

- `electron-builder.yml`：主配置
- `build/entitlements.mac.plist`：macOS 权限说明
- `package.json` 的 `dist:*` scripts 用 `cross-env` 设镜像 env

---

## 十三、架构基础

### 13.1 三层进程模型

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 1: RENDERER  (Vue3 + Pinia + Tailwind v4 + shadcn-vue)    │
│   零业务逻辑 — 所有副作用走 IPC                                   │
└────────────────────────────┬────────────────────────────────────┘
                             │ Heckmann 模式 IPC（类型自动派生）
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 2: MAIN  (Node.js + Electron)                             │
│   8 个 IPC domain + BackendManager + Codex/Claude Adapter       │
│   + better-sqlite3 + node-pty + simple-git                      │
└────────────────────────────┬────────────────────────────────────┘
                             │ spawn + newline-delimited JSON
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 3: BACKEND  (codex app-server / claude CLI，可替换)        │
└─────────────────────────────────────────────────────────────────┘
```

### 13.2 Heckmann 模式 IPC（类型自动派生）

**核心思想**：handler 函数签名即契约，类型从 main → preload → renderer 自动派生。

**好处**：改 handler 签名 → renderer 立刻编译报错 → **契约永不漂移**。

**实现位置**：`src/main/ipc/typed.ts`

### 13.3 8 个 IPC domain

| Domain | 方法数 | 职责 |
|---|---|---|
| `workspace` | 5 | 工作区 CRUD |
| `session` | 5 | 会话 CRUD + 对账 + 详情 |
| `backend` | 7 | 后端管理 + turn 流 + approval + interrupt |
| `git` | 1 | 只读 status |
| `fs` | 4 | 文件树 + 预览 + 编辑器打开 |
| `pty` | 4 | 终端创建/写/resize/kill |
| `settings` | 3 | 读写配置 |
| `system` | 3 | 平台信息 + dialog + openExternal |

**总计**：32 个 IPC 方法 + 5 个推送事件（backend:turnEvent / backend:switched / backend:statusChanged / pty:data / pty:exit）

### 13.4 项目规范技能

`.agents/skills/catmax-conventions/` 固化所有架构 + 编码规范：

- `SKILL.md`：五条硬性规则 + 反模式
- `references/architecture.md`：三层进程、目录约定、跨层 import 规则
- `references/coding-style.md`：命名、TS 配置、ESLint/Prettier、Vue SFC
- `references/ipc-pattern.md`：IPC 三件套 + 6 步流程
- `references/backend-adapter.md`：AgentBackend 接口 + 新适配器步骤
- `references/ui-conventions.md`：shadcn-vue + 主题系统 + 组件命名

**五条硬性规则**：
1. 渲染层零业务逻辑——`src/renderer/` 绝不 import `electron` 或 Node 内置
2. 新增系统操作必须先定义 IPC 契约
3. Adapter 必须实现 `AgentBackend` 接口，UI 永远不见后端协议原文
4. Zod 只用在不可信输入（子进程消息、磁盘 JSON、HTTP）
5. 时间用 Unix 毫秒，id 用 UUID v4

---

## 十四、测试覆盖

**当前 165 个自动化测试**（21 个测试文件）：

### 14.1 shared/（类型契约）

- `constants.test.ts`：5 tests（IPC channel 命名、唯一性）
- `settings-schema.test.ts`：7 tests（Zod 默认值、校验失败回退）

### 14.2 service/（业务服务）

- `database.test.ts`：19 tests（CRUD + FK cascade + app_state）
- `settings-store.test.ts`：6 tests（load/update/reset + 坏 JSON 回退）
- `git-service.test.ts`：3 tests（非 repo / 真实 repo / 修改文件）
- `file-tree.test.ts`：9 tests（递归 + gitignore + 默认忽略）
- `editor-launcher.test.ts`：6 tests（5 IDE 命令格式）
- `pty-manager.test.ts`：4 tests（create + write + kill + exit）
- `codex-resolver.test.ts`：3 tests（路径解析）

### 14.3 backend/（后端适配器）

- `protocol-schema.test.ts`：12 tests（codex JSON-RPC schema）
- `claude-protocol-schema.test.ts`：8 tests（claude stream-json schema）
- `protocol.test.ts`：16 tests（LineBuffer + parseFrame + classify）
- `mapping.test.ts`：15 tests（codex event → TurnEvent + risk 评估）
- `claude-mapping.test.ts`：14 tests（claude message → TurnEvent）
- `codex-history-mapping.test.ts`：6 tests（codex thread.read → NormalizedMessage）
- `claude-history-mapping.test.ts`：6 tests（claude replay → NormalizedMessage）
- `adapter.test.ts`：5 tests（CodexAdapter 完整流程 + getHistory）
- `claude-adapter.test.ts`：5 tests（ClaudeAdapter 完整流程）

### 14.4 ipc/（IPC 层）

- `typed.test.ts`：2 tests（重复注册抛错）
- `workspace-handlers.test.ts`：10 tests（CRUD + 错误码）
- `settings-handlers.test.ts`：4 tests（CRUD）

**测试策略**：
- Adapter 测试用 mock spawn（不需要真实 codex/claude CLI）
- 数据库测试用 tempdir（隔离）
- 需要 Node 内置的测试加 `// @vitest-environment node`（happy-dom 限制）

---

## 未实现 / 后续规划

### 已设计但未完整实现

- **凭证管理 UI**：API key 存储 + "测试连接"按钮（IPC 已就绪，UI 待补）
- **HTTP 代理应用**：设置字段已有，实际给子进程传 proxy env 未接
- **i18n**：设置里有 `language` 字段，UI 实际只显示中文

### 设计文档明确 out of MVP scope

- **Git 写操作**（commit/push/branch/merge/PR）—— 只读够用
- **文件编辑**（仅预览）—— 编辑走外部编辑器
- **自动化引擎**（cron + RRule）—— 借鉴 Codex，但需要调度系统
- **Inbox 系统** —— 后台运行结果审查
- **Cloud worktree 快照** —— 需要服务端配合
- **自研 agent loop** —— 不依赖外部 CLI，直接调 LLM API
- **多窗口** —— 当前一个窗口
- **Linux 支持** —— 当前 macOS + Windows
- **OAuth2 PKCE** —— 自有账号系统

### 工程化加固（未做）

- **CI/CD**：GitHub Actions 自动 lint/typecheck/test/build
- **错误监控**：Sentry 集成
- **自动更新**：`electron-updater` 已装但未接入
- **E2E 测试**：Playwright 桌面应用测试
- **应用图标**：当前用默认 Electron 图标

---

## 项目数据（截至 2026-07-19）

| 指标 | 数值 |
|---|---|
| 总 commit | 84 |
| src 文件 | 110（.ts + .vue） |
| src 代码行 | 8,581 |
| 测试文件 | 21 |
| 测试代码行 | 2,526 |
| 自动化测试 | 165/165 通过 |
| 文档 | 15（设计 + 规范技能 + 6 plan + 6 smoke test + README + 本文档） |
| Plan 数 | 6（Plan 1 + 2 + 3 + 4a + 4b + 5） |
| IPC domain | 8 |
| IPC 方法 | 32 |
| 推送事件 | 5 |
| Vue 组件 | 24 |
| Pinia store | 9 |

---

*文档版本：v1.0（2026-07-19，Plan 5 合并后）*
*维护者：shawn*
