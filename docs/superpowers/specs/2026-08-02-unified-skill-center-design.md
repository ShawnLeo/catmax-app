# 统一技能中心（Unified Skill Center）调研与设计

- **状态**：设计中，未实现
- **日期**：2026-08-02
- **范围**：让 codex 与 claude 两个后端读到同一份技能；技能的开/关；显示技能所在位置并用外部编辑器打开；新建会话页显示当前项目技能数量并可开关/删除
- **不在范围**：应用内编辑技能正文、远程技能市场/下载
- **探测环境**：codex-cli 0.145.0 · `@anthropic-ai/claude-agent-sdk` 0.3.220（内置 claude 2.1.220）· macOS

---

## 0. 本文的事实来源

下面每一条"实测"都来自本次真跑的探针，不是读文档或凭印象：

- codex 侧用 `codex app-server generate-ts --out <dir>` 导出协议 TS 绑定（**这是本次发现的新工具**，比读二进制字符串准得多，见 §7），再起一个真的 app-server 逐个调 RPC。
- claude 侧用 `query()` 只握手不发消息（复用 `.claude/skills/slash-command-audit` 的 `neverEndingPrompt` 手法），读 `initializationResult().commands`——技能对用户是可斜杠调用的，所以它出现在命令表里，这就是一个不花 token 的可观测量。

凡是没跑通的，本文都标了「未验证」，不会写成结论。

---

## 1. 结论速览

1. **`~/.agents/skills` 已经是 codex 的原生全局技能目录**，无需任何配置。仓库级同理：`<repo>/.agents/skills`。这台机器上 27 个 lark-\* 技能就住在那里。
2. **claude 完全不认识 `.agents`**——二进制里连这个字符串都没有。它只看 `~/.claude/skills`、`<repo>/.claude/skills`、plugin 目录。
3. 所以"统一"的成本是**单向**的：codex 零成本，claude 需要一座桥。这台机器上已经有人搭过这座桥了——`~/.claude/skills/lark-*` 全是指向 `../../.agents/skills/*` 的**软链**。
4. 桥有两种搭法，实测下来**只有软链能用**：local plugin 那条路能让 claude 读到外部目录，但会把技能名改成 `plugin:skill`，而**带命名空间的技能关不掉**（两种 key 形式都试过，无效）。关技能是这次的硬需求，所以 plugin 方案出局。
5. **开关技能两边都有真机制**，但语义不对称：
   - codex `skills/config/write` 写进 `~/.codex/config.toml`，是**全局的**，会连带影响用户自己的 codex CLI。
   - claude 只能靠 `settings.skillOverrides`，而 catmax **已经有**一个 flag 层覆盖文件（`Options.settings`）可以承载它，**只影响 catmax 内的会话**。
6. catmax 的覆盖层可以直接传**内联 Settings 对象**（`settings?: string | Settings`），不必再落一个文件——实测生效。
7. 有一条可能消除上述不对称的线索（`thread/start.config` 传 `skills.config`），key 被 codex 认，thread/start 也收，但**没验证到真的对该 thread 生效**。按未验证处理，见 §6。

---

## 2. 技能发现路径（实测）

### 2.1 codex 0.145.0

`skills/list` 返回每个技能的 `path`，按父目录归并后得到真实扫描根：

| 根目录 | scope | 本机命中 |
|---|---|---|
| `~/.agents/skills` | `user` | 27 |
| `~/.codex/skills` | `user` | 10 |
| `~/.codex/skills/.system` | `system` | 6 |
| `~/.codex/plugins/cache/**/skills` | `user` | 12（名字带 `plugin:` 前缀） |
| `<repo>/.agents/skills` | `repo` | ✅ 实测命中 |
| `<repo>/.codex/skills` | `repo` | ✅ 实测命中 |
| `<repo>/.claude/skills` | — | ❌ 不扫 |

另有运行时接口 `skills/extraRoots/set { extraRoots: AbsolutePathBuf[] }`：往里塞一个临时目录后 `skills/list --forceReload` 立刻多出该技能（scope 记为 `user`）。**codex 这边即使 `.agents` 约定哪天变了，也还有这条后路。**

### 2.2 claude（内置 2.1.220）

扫 `~/.claude/skills`、`<repo>/.claude/skills`、`plugins[]` 指定的插件目录、内置技能。由 `settingSources` 控制：传 `[]` 时命令数从 79 掉到 42（只剩内置命令），用户/项目技能全部消失。

`strings` 扫二进制：`".claude/skills"` 有，`".agents"` **一个都没有**。

### 2.3 当前的漂移

`~/.claude/skills` 37 项 vs `~/.codex/skills` 11 项，其中 10 个同名目录是**各自独立的副本**（不是软链），已经开始分叉。这正是要做统一中心的原因。

---

## 3. 开/关技能（实测）

### 3.1 codex：`skills/config/write`

```
skills/config/write { path?: string | null, name?: string | null, enabled: boolean }
  → { effectiveEnabled: boolean }
```

- 落盘位置：`~/.codex/config.toml` 追加
  ```toml
  [[skills.config]]
  name = "web-perf"
  enabled = false
  ```
  重新置 `enabled: true` 会把这条**整段删掉**，是干净的 override 语义。
- 写完会推 `skills/changed` 通知，按"缓存失效"处理并重新 `skills/list`。
- ⚠️ **坑：`path` 必须是 `skills/list` 返回的 SKILL.md 全路径。** 传技能**目录**时响应照样是 `{"effectiveEnabled": false}`，但**实际没生效**——一个会骗人的成功响应。这类静默失败必须在实现里用测试钉死。
- ⚠️ **影响范围是全局的**：写的是用户自己的 `~/.codex/config.toml`，用户在终端跑 codex 时这个技能也是关的。

### 3.2 claude：只有 `skillOverrides` 能用

SDK typings 里有两个看起来能用的东西，实测只有一个真的能用：

| 机制 | 实测结果 |
|---|---|
| `Options.managedSettings.skillOverrides` | ❌ **无效**。`skillOverrides` 和 `disableBundledSkills` 都试过，命令数纹丝不动。typings 跑在内置 2.1.220 前面了。 |
| `settings.skillOverrides`（文件路径或内联对象） | ✅ **有效**。79 → 77，`lark-base`（user 级）和 `repo-claude-demo`（项目级）同时消失。 |
| `Options.skills: string[] \| 'all'` | ⚠️ 只是**上下文过滤器**：命令表纹丝不动，斜杠命令照样能打。它管的是"模型看不看得见 / Skill 工具认不认"。 |

`skillOverrides` 的取值：`'on' | 'name-only' | 'user-invocable-only' | 'off'`。
- `off` = 模型和用户都看不见（我们要的"关闭"）
- `name-only` = 只列名字不列描述（省 context 的中间档）
- `user-invocable-only` = 模型看不见但 `/name` 还能打

**关键的可用性发现**：catmax 已经有一个 flag 层覆盖文件（`userData/backend-settings/claude-settings.json`，经 `Options.settings` 传入，见 `claude/adapter.ts` 的 `applyOverrideSettings`）。把 `skillOverrides` 放进去实测生效，**不用碰用户的 `~/.claude/settings.json`**。而且 `settings?: string | Settings` 也接受**内联对象**，同样实测生效——所以不必为此再多落一个文件。

### 3.3 命名空间技能关不掉（这条决定了 §4 的选型）

对 local plugin 提供的 `catmax-unified:catmax-probe-uniq`：

- `skillOverrides['catmax-unified:catmax-probe-uniq'] = 'off'` → 无效
- `skillOverrides['catmax-probe-uniq'] = 'off'` → 无效
- `'user-invocable-only'` → 同样无效

**结论：plugin 提供的技能目前无法通过 skillOverrides 关闭。**

---

## 4. 设计

### 4.1 统一根目录：`~/.agents/skills` + `<repo>/.agents/skills`

理由：codex 原生就读这两处，选它等于 codex 侧零成本；而 `.agents` 也确实是 codex 正在推的跨 agent 约定——它的个人 marketplace 默认路径就是 `~/.agents/plugins/marketplace.json`，并且同时认 `.codex-plugin/plugin.json`、`.claude-plugin/plugin.json`、`.cursor-plugin/plugin.json`。

> 需求里写的是 `.agent`（单数），实际约定是 `.agents`（复数）。跟着 codex 已经在读的那个走，能省掉一整套配置。

⚠️ **这台机器上 `~/.agents` 是 root 所有**（`drwxr-xr-x root staff`，由那个装 lark 技能的安装器创建）。catmax 在这里建软链/删目录都会 `EACCES`。实现必须显式探测可写性并把原因摆到界面上，而不是让操作静默失败。

### 4.2 claude 的桥：受管软链（mirror），不是 plugin

catmax 维护一批软链，并且**只维护自己建的那些**：

```
~/.claude/skills/<name>          → ~/.agents/skills/<name>
<repo>/.claude/skills/<name>     → ../../.agents/skills/<name>
```

规则（每一条都是为了防止误删用户的真技能）：

1. **清单化**：建过的链记进 `userData/skill-mirror.json`。清理时只删清单里有的。
2. **绝不删非软链**；绝不删不在清单里的软链。用户手工建的（比如现有的 lark-\*，root 所有）识别为"已经通了"，接管但不重建。
3. **Windows**：目录软链用 `fs.symlink(target, path, 'junction')`——junction 不需要管理员权限或开发者模式。
4. **项目级软链要顺手写 `.git/info/exclude`**：那是 per-clone 的、不会被提交，仓库保持干净。往 `.gitignore` 里写就是在改用户的仓库文件，不行。
5. **反向迁移是显式操作**：`~/.claude/skills` 里那些真目录（本机 10 个）不自动搬。提供一个"迁移到统一目录"的按钮：移动目录到 `~/.agents/skills` 并在原地留一个软链。自动搬用户文件这种事不能替他做主。

**被否掉的方案：bridge plugin。** `plugins: [{ type:'local', path, skipMcpDiscovery: true }]` 配一个 `skills` 软链到统一根，实测**能读到**（`catmax-unified:catmax-probe-uniq` 出现在命令表里），而且完全不碰用户的 `~/.claude/skills`，看起来更干净。但它把名字变成了 `plugin:skill`，而 §3.3 实测**这类技能关不掉**。关技能是硬需求，所以出局。

### 4.3 开关：一份 catmax 状态，投影到两个后端

catmax 自己存一份 `userData/skills-state.json`：

```jsonc
{ "disabled": { "/Users/x/.agents/skills/lark-base/SKILL.md": true } }
```

**用统一根里的 SKILL.md 绝对路径作 key**，不用名字——path 是两个后端都能表达的唯一标识，而 codex 的 `name` 选择器在多根同名时是有歧义的。

投影：

- **codex**：启动时和状态变更时 `skills/config/write { path: <SKILL.md 全路径>, enabled }`。路径必须原样用 `skills/list` 返回的那个（软链只影响 claude 看到的路径，codex 直接读统一根，不受影响）。
- **claude**：构造 query 时把 `skillOverrides: { <name>: 'off' }` 合进 flag 层。当前 `applyOverrideSettings` 是"传一个路径"，需要改成"没有 override 时仍传路径，有 override 时读出文件内容 + 合上 `skillOverrides` 传内联对象"——保持"无覆盖时 catmax 不做任何合并"这条既有不变量。

**必须如实告诉用户的不对称**：codex 的关闭写进 `~/.codex/config.toml`，用户终端里的 codex 也会跟着关；claude 的关闭只在 catmax 内生效。这不是实现偷懒——`ThreadStartParams` 里没有任何技能过滤字段，codex 没有 per-session 的关法。UI 上给 codex 的开关标一句"同时影响终端里的 codex"。

### 4.4 IPC：新开一个 `skills` 域

按 CLAUDE.md 的 8 域惯例（一个域一个关注点），加第 9 个 `skills` 域比塞进 `backend` 干净：

| 方法 | 说明 |
|---|---|
| `skills.list(workspaceId)` | 返回统一视图：全局 + 当前项目，每条带 `path` / `scope` / `enabled` / `visibleTo: BackendId[]` |
| `skills.setEnabled(path, enabled)` | 写 catmax 状态 + 投影到两个后端 |
| `skills.mirror(path)` | 为某个技能补上 claude 侧软链（修复"只有 codex 看得到"） |
| `skills.reveal(path)` | 在访达/资源管理器中显示 |
| `skills.openExternal(path)` | 用默认编辑器打开 SKILL.md（复用 workspace 域已有的 default editor） |
| `skills.remove(path)` | 仅项目级；删目录 + 软链 |

`skills.remove` 的守卫：路径必须在当前工作区内、必须可写、必须确认。越界或只读时报错，不试图 sudo。

### 4.5 UI

**设置页新增「技能」区**：按 全局 / 当前项目 分组。每行：名称、描述、scope 徽标、**两个后端的可见性**（`✓codex ✓claude`；只有一边时给一个「修复」按钮触发 `skills.mirror`）、开关、路径 + 「在编辑器中打开」「在访达中显示」。

**新建会话页**：在 [ChatView.vue:105](../../../src/renderer/src/views/ChatView.vue) 那条 `工作区 | 后端` 里加第三段 `技能 N`（N = 当前项目已启用的技能数）。点开一个 popover 列出项目技能，行内可开/关/删。

### 4.6 刷新

- codex：订阅 `skills/changed` → `skills/list { forceReload: true }`。
- claude：没有对应通知，catmax 自己扫盘。窗口重新聚焦、popover 打开时各扫一次即可，不值得为此上 watcher。

---

## 5. 分期

| 期 | 内容 | 依赖 |
|---|---|---|
| 1 | `skills` IPC 域 + 统一扫描（含 `visibleTo` 计算）+ 设置页只读列表 + 打开/定位 | 无 |
| 2 | 受管软链（清单 + junction + `.git/info/exclude`）+ 「修复可见性」 | 1 |
| 3 | 开关：catmax 状态 + 两个后端投影 | 1 |
| 4 | 新建会话页技能数量 + popover（开关/删除） | 3 |
| 5 | 反向迁移（`~/.claude/skills` 真目录 → 统一根） | 2 |

---

## 6. 未验证的线索：codex 的 per-session 关闭

如果成立，§4.3 那条不对称就没了。

已知：
- `skills.config` 是 codex **认识**的配置字段——`codex app-server --strict-config -c 'skills.config=[{name="x",enabled=false}]'` 正常启动，而对照组 `-c 'zzz_not_a_key.foo=1'` 报 `unknown configuration field`。
- `ThreadStartParams.config?: { [key: string]: JsonValue }` 存在，塞 `skills.config` 进去 `thread/start` 正常返回 threadId。

未知：**thread 级别到底生不生效**。`thread/start` 成功只说明参数被收下了，不代表技能真的从这个 thread 的 system prompt 里去掉了。要证实必须真跑一轮 turn 去观察模型侧的技能清单——那要花真实额度，所以本次没做。

处置：先按 §4.3 的全局方案实现（已验证）；这条线索单独验证通过后再作为 Phase 2 升级。**不要在没跑过 turn 之前就按它设计。**

---

## 7. 顺带发现：codex 协议有官方 TS/JSON Schema 导出

```bash
codex app-server generate-ts --out <dir>
codex app-server generate-json-schema --out <dir>
```

导出 `ClientRequest.ts`（92 个方法名，每个带参数类型）和 `v2/` 下 526 个结构体定义。

这直接影响 `.claude/skills/slash-command-audit` 的 codex 分支：现在那个探针是从二进制 `strings` 里捞方法名的，为此踩了三个坑（无分隔符总表、17KB 诱饵字符串、静默降级）。改成跑 `generate-ts` 再解析 `ClientRequest.ts`，三个坑全部消失，而且能顺带 diff 参数结构的变化——现在只能 diff 方法名。**建议单独开一期把审计脚本换过去。**

---

## 8. 相关文件

- `src/main/backend/claude/adapter.ts` 的 `applyOverrideSettings` — flag 层覆盖的注入点
- `src/main/service/backend-config-files.ts` 的 `claudeOverrideSettingsPath` — 覆盖文件路径
- `src/main/backend/codex/adapter.ts` 的 `sendWithThreadResume` — codex RPC 调用点
- [ChatView.vue:105](../../../src/renderer/src/views/ChatView.vue) — 新建会话页 `工作区 | 后端` 那一行
- `.claude/skills/slash-command-audit/` — codex RPC 审计（见 §7）
