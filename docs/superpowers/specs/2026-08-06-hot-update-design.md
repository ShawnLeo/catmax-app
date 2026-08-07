# Electron 增量热更新（Hot Update）调研与设计

- **状态**：**Phase 0（PoC）与 Phase 1（bootstrap 状态机 + 回滚）已完成**。Phase 2 进行中：离线签名链路已完成（§8.5），R2 基础设施已搭建（§9.5），剩 scoped API token + 发布脚本的上传步骤。
- **日期**：2026-08-06 初稿 · 2026-08-07 修订（补 §5.6–5.9 更新生命周期与 §9 发布自动化；统一"路线/通道"命名；确定第一期范围）· 2026-08-07 Phase 0 完成（§0.3 结论、新增 §5.10）· 2026-08-07 Phase 1 完成（§5.11 实现说明）· 2026-08-07 R2 基础设施搭建（§9.5 记录）
- **范围**：让 catmax-app 的业务代码变更（`out/main` + `out/preload` + `out/renderer`）能够不重装、不下载完整安装包地送达用户；以及配套的服务端文件布局、manifest 协议、版本模型、回滚与安全机制
- **第一期范围**：**仅 macOS，仅热更新通道，本地发布**。Windows 分发与 GitHub Actions CI 推迟（§9.2、§10）
- **不在范围**：Electron 自身升级、native 模块（`better-sqlite3` / `node-pty`）升级、claude 二进制升级——这三类**只能**走完整安装包（§4.3）；Linux 分发
- **探测环境**：electron 31.7.7 · electron-builder 24.13.3 · electron-updater 6.3.9（已装未接入）· macOS 26 (Darwin 25.5.0) · arm64
- **前置改动**：本文的体积数字基于 2026-08-06 的打包瘦身（`files` 改白名单、dependencies 重划分、`afterPack` 按架构裁剪 claude 二进制）。瘦身之前 `out/` 的占比太低，热更新的收益算不出来

---

## 0. 本文的事实来源

### 0.1 实测结论（本机真跑出来的）

| 事实 | 怎么测的 |
|---|---|
| 瘦身后 dmg 168 MB / app.asar 28 MB / unpacked 259 MB，其中 `out/` 仅 14 MB | `du` + `@electron/asar list` |
| 当前 app 是 **adhoc, linker-signed**，且 `codesign --verify` 已失败（`code has no resources but signature indicates they must be present`） | `codesign -dv --verbose=4` / `codesign --verify --deep --strict` |
| 所有 Electron fuse 处于默认宽松状态，`EnableEmbeddedAsarIntegrityValidation` 和 `OnlyLoadAppFromAsar` 均为 Disabled | `@electron/fuses read --app` |
| electron-builder 的 node_modules 收集器**只接受 `!` 排除规则**，白名单对它无效 | 读 `app-builder-lib/out/fileMatcher.js` 的 `getNodeModuleFileMatcher()`：注释原文 "grab only excludes" |
| 主 matcher 恒定追加 `!**/node_modules`，所以 `files` 白名单不会误伤依赖 | 同上，`getMainFileMatchers()` |
| `files` 的 pattern 支持 `${arch}` 等宏 | 同上第 50 行 `this.macroExpander(pattern)` |
| electron-builder 只按 package.json 的 `os` 过滤平台包，**不看 `cpu`** | arm64 的包里同时存在 `claude-agent-sdk-darwin-arm64`(245M) 与 `-darwin-x64`(254M) |
| preload 与 renderer 都按 `__dirname` 相对定位 | `src/main/window.ts:35`（`join(__dirname, '../preload')`）、`:192`（`loadFile(join(__dirname, '../renderer/index.html'))`） |
| icon / tray 走 `app.getAppPath()` + `process.resourcesPath`，不依赖 `__dirname` 主路径 | `src/main/window.ts:21-23`、`src/main/tray.ts:57-58` |
| CDP 远程调试仅 dev 开启，打包产物不暴露 | `src/main/index.ts:33` 的 `is.dev` 判断 |
| GitHub 仓库 `ShawnLeo/catmax-app` 是 **public** | 匿名 `curl https://api.github.com/repos/ShawnLeo/catmax-app` 返回 200 且 `"private": false` |
| **`electron-builder.yml` 没有 `publish` 段**，`package.json` 无 `repository` 字段，全仓不存在 `app-update.yml` | `grep publish electron-builder.yml` / `find . -name app-update.yml` |
| 现有 `dist/latest-mac.yml` 只列两个 dmg、`path` 也指向 dmg，**对 electron-updater 无效** | 读 `dist/latest-mac.yml` |
| `wrangler r2 object put` 同时有 `--local` / `--remote` 开关，并支持 `--content-type` / `--cache-control` | `npx wrangler@4 r2 object put --help`（4.119.0） |
| **wrangler 已全局安装（4.119.0），OAuth 登录态已建立**（账号 `shawn525686@gmail.com`，token 在 `~/Library/Preferences/.wrangler/config/default.toml`） | `wrangler --version` / `wrangler whoami`（2026-08-07） |
| 本机未装 `gh`，无 `CLOUDFLARE_*` 环境变量 | `which gh` / `env \| grep CLOUDFLARE` |

### 0.2 引用官方文档 / 源码，但未在本机复现

- **Squirrel.Mac 要求正式开发者签名**，ad-hoc 不被接受 → electron-updater 在当前未签名的 mac 构建上无法工作。来源：electron-builder 官方 auto-update 文档「macOS application must be signed in order for auto updating to work」，以及 electron-builder#7356、Squirrel.Mac#179。
- **electron-updater 的 macOS 更新走 zip，不走 dmg**：`MacUpdater.ts` 里 `findFile(files, "zip", ["pkg", "dmg"])`，且差分下载依赖缓存的 `update.zip`（首次安装无差分）。当前 `electron-builder.yml` 的 mac target 只有 `dmg`，`latest-mac.yml` 里没有 zip 条目。
- **electron-builder 26 起，Windows 构建强制开启 `EnableEmbeddedAsarIntegrityValidation` + `OnlyLoadAppFromAsar` 且不可关闭**。开启后 Electron 启动时校验 asar 哈希，不匹配即进程终止。
- **ASAR integrity 的平台支持**：macOS 需 Electron ≥16，Windows 需 Electron ≥30；替换 app.asar 会导致哈希不匹配、应用被强制终止。来源：Electron 官方 ASAR Integrity 文档。
- **修改已签名 .app bundle 内任何文件都会让签名失效**。来源：Apple Developer Forums 多个 thread。

### 0.3 PoC 结论（Phase 0，**2026-08-07 已完成**）

**三条假设全部成立，架构无需推翻——但假设 1 附带一个 PoC 之前完全没预见到的硬前提，它改变了构建配置和 §5 的一部分内容（见 §5.10）。**

PoC 方式：把真实的 `out/` 复制到 `userData/hot-updates/versions/h1/`，注入两处肉眼可见的标记（main 顶部的 `console.log`、renderer 的角标），用 `electron-builder --mac --arm64 --dir` 打真包运行。

| 假设 | 结论 | 说明 |
|---|---|---|
| 1. ESM 主进程能否从 userData 动态 `import()` | ✅ 成立，**但有硬前提** | 见下方「重大发现」。退路（打成 CJS）**未被使用** |
| 2. `hardenedRuntime` 是否阻止加载 bundle 外的 JS | ✅ 不阻止 | 用 `codesign --force --deep --sign - --options runtime` 造出 `flags=0x10002(adhoc,runtime)` 的包实测，侧载照常工作 |
| 3. renderer 相对资源与 preload 能否从 userData 加载 | ✅ 完全正常 | 截图确认角标出现且整个 UI（logo/按钮/最近工作区列表）完整渲染——assets 与 preload 均正常。`app://` 自定义 protocol 的退路**不需要** |

#### 重大发现：热更新产物必须**自包含**

侧载的第一次运行连续撞了三个错误，每一个都会让应用起不来：

1. **`SyntaxError: Cannot use import statement outside a module`** —— `.js` 的模块类型由**最近的 package.json 的 `type` 字段**决定。asar 内有 `"type": "module"`，而 userData 那棵目录树里一个 package.json 都没有，Node 于是按 CJS 解析。**修法**：热更新包必须包含 `versions/<n>/package.json` = `{"type":"module"}`（这与 §6.2 "package.json 不能进热更新包"不冲突，那条禁止的是复制**应用的** package.json）。
2. **`ERR_MODULE_NOT_FOUND: Cannot find package 'fix-path'`** —— 这条是真正的架构约束。ESM 的 bare specifier 按 **importer 所在目录**向上找 `node_modules`，侧载位置一路找到用户家目录都没有。**在侧载目录建符号链接指向 asar 内的 `node_modules` 无效**：ESM resolver 在 C++ 层实现，不经过 Electron 给 `fs` 打的 asar patch（实测）。**修法**：纯 JS 依赖一律 bundle 进产物，详见 §5.10。
3. **`ReferenceError: __dirname is not defined`** —— electron-vite 是否注入 `const __dirname = import.meta.dirname` 会随 external/bundle 配置变化。改了 `externalizeDepsPlugin` 的 `exclude` 之后注入就消失了，窗口都建不出来。**修法**：源码直接用 ESM 原生的 `import.meta.dirname`，不依赖 bundler 注入（已改 `window.ts` / `tray.ts`）。

配套的正面结论：**CJS 的 `createRequire` 可以穿透 asar**，`better-sqlite3`、`node-pty` 这两个位于 `app.asar.unpacked` 的 native 模块都实测加载成功——这正是 §5.10 里 shim 的实现基础。

#### 仍未验证

- Windows 的 `perMachine: false` 装在 `%LOCALAPPDATA%`、写 userData 不触发 UAC（第一期不做 Windows，§9.2）
- 热更新后 `app.getVersion()` 仍返回宿主版本 —— PoC 中 bootstrap 打印的 `app.getVersion() = 0.1.0` 与宿主一致，但没有在"宿主版本 ≠ 热更新 baseVersion"的场景下专门验证过

---

## 1. 结论速览

1. **"增量更新"和"热更新"是两件事，本项目两件都要，但用在不同场景。** 差分下载（blockmap）仍然要重装+重启，只是下载量小；热更新不碰安装包，重启进程即可生效。
2. **选定路线：userData 侧载（CodePush 风格）**，即 app bundle 保持不变，业务代码 `out/` 放到 `userData` 下由 bootstrap 决定加载哪一份。理由不是它最简单（替换 app.asar 更简单），而是它是唯一同时满足下面四条的方案：不破坏 macOS 代码签名、不受 asar integrity fuse 影响（因此可以安全升级 electron-builder 到 26+）、回滚只需改一个 JSON、将来正式签名了也不用改架构。
3. **服务端不需要写应用服务器。** 静态文件托管 + 一个 manifest.json 就是完整的第一版。灰度和统计需要动态接口，但可以后加，且只需要一个 GET。
4. **热更新包只含 `out/` 三个子目录，约 4~5 MB（tar.gz 后）**，相对完整包 168 MB。
5. **对当前这个未签名的 macOS 构建，热更新不是"更好的方案"，而是唯一可行的自动更新路径**——Squirrel.Mac 拒绝 ad-hoc 签名（§0.2），完整包通道在 mac 上根本起不来。
6. **整个设计里风险最高、最不能省的部分是"启动确认 + 失败自动回滚"**（§5.4）。热更新的失败模式是"一个坏包让所有用户的 app 永久打不开，且恢复逻辑本身也在坏掉的代码里"，必须由 bootstrap 兜住。

---

## 2. 问题：为什么现在这个包不适合全量更新

2026-08-06 打包瘦身后的实测构成：

```
Catmax-0.1.0-arm64.dmg                    168 MB
└─ Catmax.app/Contents/Resources/
   ├─ app.asar                             28 MB
   │  ├─ node_modules                     ~14 MB  (@modelcontextprotocol/sdk, claude-agent-sdk, simple-git…)
   │  ├─ out                               14 MB  ← 每次发版真正变化的只有这里
   │  ├─ resources                         84 KB
   │  └─ package.json
   └─ app.asar.unpacked                   259 MB
      └─ node_modules/@anthropic-ai       256 MB  ← claude 二进制，随 SDK 升级才变
```

**变化频率与体积严重倒挂**：占 92% 体积的部分（claude 二进制 + native 模块）几个月才动一次，占 8% 的 `out/` 每次发版都变。让用户为一次改了几十 KB 的 bug fix 下载 168 MB，是这个方案要解决的核心问题。

---

## 3. 三条技术路线与取舍

### 3.1 路线 A：electron-updater + blockmap 差分下载

electron-builder 为每个安装包生成 `.blockmap`（当前 dist 里已有），更新时对比新旧 blockmap，用 HTTP Range 只拉变化的块。

- ✅ 官方方案，依赖已装（`electron-updater@6.3.9`），Windows NSIS 开箱可用
- ✅ 能更新任何东西（Electron 版本、native 模块、二进制）
- ❌ **macOS 上当前跑不起来**：需要正式开发者签名（§0.2），而当前是 ad-hoc
- ❌ mac 侧还需要补 `zip` target，当前只出 dmg
- ❌ 仍然要重装 + 重启，且首次安装无差分基准

### 3.2 路线 B：替换 app.asar

下载新的 `app.asar` 覆盖 `Contents/Resources/app.asar`，重启生效。中文社区教程最多的一种。

- ✅ 实现最简单，包小
- ❌ **macOS**：改 bundle 内任何文件都会让签名失效。当前是 ad-hoc 所以"反正也没签名"能跑，但一旦将来正式签名，这条路自动作废
- ❌ **electron-builder 26 起 Windows 强制开启 asar integrity fuse 且不可关闭**（§0.2）。当前 24.13.3 的 fuse 是关的（§0.1）所以能用——但这等于把"永远不升级 electron-builder"写进了架构约束
- ❌ 回滚需要保留旧 asar 并再覆盖一次，中途失败会留下半个文件

**不采用。** 它用一个今天能跑的实现，换了一个明确会在未来某次依赖升级时爆炸的约束。

### 3.3 路线 C：userData 侧载（**选定**）

app bundle 内的 `app.asar` 只保留一个极薄的 bootstrap 和一份内置 `out/` 作为兜底；真正加载的业务代码放在 `userData/hot-updates/versions/<n>/`。

- ✅ 不碰 app bundle → macOS 签名不失效，将来正式签名也不用改架构
- ✅ 不碰 app.asar → asar integrity fuse 开不开都无所谓，可以安全升级 electron-builder
- ✅ 回滚 = 改一个 JSON 字段，旧版本目录还在原地
- ✅ 天然支持"下载完成但下次启动才生效"和多版本并存
- ⚠️ 只能更新纯 JS（§4.3），且需要自建 manifest / 签名 / 状态机
- ⚠️ 依赖 §0.3 的三条假设

### 3.4 落地形态：两条发布通道（术语约定）

**路线 C 被选定，路线 B 被否决——但这不代表路线 A 消失了。** §4.3 会说明：native 模块、Electron 自身、claude 二进制**在物理上无法热更新**，它们的变更只能靠重装。所以本方案最终落地成**两条并存的发布通道**，路线 A 与 C 各自成为其中一条的实现手段：

| 发布通道 | 承载的变更 | 实现手段 | 频率 |
|---|---|---|---|
| **热更新通道** | 业务代码（`out/main` `out/preload` `out/renderer`） | **路线 C**（userData 侧载） | 每次发版，占 95%+ |
| **完整包通道** | Electron 升级 / native 模块 / claude SDK / 新增 dependency / bootstrap 自身 | **路线 A**（electron-updater + blockmap） | 数月一次 |

> 📌 **本文后续一律使用"通道"而不是字母。** 本文早期版本把两条通道也叫作"线 A / 线 B"，与 §3 的"路线 A/B/C"在中文里几乎无法区分——尤其"热更新通道"当时叫"线 B"，极易被误读成已否决的"路线 B（替换 app.asar）"。现已全部改名。**路线 B 不出现在任何落地设计中。**

走哪条通道由发布脚本按 `runtimeId` 自动判定（§7.3、§9.1），不靠人记。

---

## 4. 硬约束

### 4.1 macOS 没有开发者签名

当前状态是 `Signature=adhoc (linker-signed)`，`codesign --verify` 已经失败（§0.1）。这带来三个后果：

1. 路线 A 在 mac 上不可用 → 热更新是 mac 侧唯一的自动更新路径
2. 用户下载 dmg 时会被 Gatekeeper 拦（quarantine 属性 + 无有效签名），需要手动 `xattr -cr`。这是**现状**，热更新不改变它——但热更新反而能显著减少用户遇到它的次数，因为不用反复下 dmg
3. 如果将来买了 Apple Developer（$99/年）做签名 + 公证：路线 A 在 mac 上解锁，而路线 C 因为不碰 bundle **不需要任何改动**

### 4.2 electron-builder 26 的 asar integrity

见 §0.2 和 §3.2。这一条是排除路线 B 的决定性理由，也是路线 C 的主要论据之一。

### 4.3 native 模块与二进制永远不能热更新

`better-sqlite3` / `node-pty` 是编译产物，ABI 绑定 Electron 版本；`claude-agent-sdk-*/claude` 是 256 MB 的平台二进制，在 `app.asar.unpacked` 里且受 macOS 签名约束。这些只能走完整安装包。

由此推出一条必须在协议层表达的约束：**热更新包必须声明它假设的 native 环境**，否则会出现"热更新的 JS 调用了新版 better-sqlite3 的 API，但用户机器上的 `.node` 还是旧的 → 启动即崩"。这就是 §7.3 的 `runtimeId`。

### 4.4 Windows 安装位置有利

`nsis.perMachine: false` → 装在 `%LOCALAPPDATA%`，写 userData 不需要管理员权限，没有 UAC 弹窗问题（推断，建议实测确认）。

---

## 5. 客户端架构

### 5.1 目录布局

```
<userData>/hot-updates/
├── state.json                 # 状态机的唯一真相
├── staging/                   # 下载 + 解压中转，成功后才 rename 出去
│   └── h4.tar.gz
└── versions/
    ├── h3/                    # 与 asar 内 out/ 结构完全一致
    │   ├── main/index.js
    │   ├── preload/index.mjs
    │   └── renderer/index.html + assets/**
    └── h4/
```

`versions/<n>/` 的内部结构必须和 asar 里的 `out/` **逐字节同构**，这样 `__dirname` 的相对路径语义在两种加载方式下完全一致（§5.5）。

### 5.2 state.json

```json
{
  "baseVersion": "0.1.0",
  "runtimeId": "a3f9c2e18b04",
  "active": 4,
  "confirmed": 3,
  "staged": 5,
  "bootAttempts": 1,
  "lastCheckAt": 1786032000000
}
```

| 字段 | 含义 |
|---|---|
| `baseVersion` | 这些热更新是给哪个宿主版本的。与 `app.getVersion()` 不符时全部作废（§7.2） |
| `runtimeId` | 写入时的 native 环境指纹，与宿主实际指纹不符时作废（§7.3） |
| `active` | 本次应该加载哪个版本。`0` 表示用 asar 内置 |
| `confirmed` | 已被证明能正常启动的最后一个版本，回滚目标 |
| `staged` | **已下载校验完毕、等待下次启动生效**的版本；`null` 表示没有待生效包。它与 `active` 分离是必须的——见 §5.6 |
| `bootAttempts` | `active` 连续启动尝试次数，≥2 判定为坏包 |
| `lastCheckAt` | 上次成功拉取 manifest 的时间，用于限流（§5.6） |

`staged` 与 `active` 必须是两个字段而不是一个。如果下载完直接改 `active`，那么"下载完成"到"下次启动"之间的整段时间里，`state.json` 描述的是一个**当前进程并没有在运行的版本**——此时若进程崩溃并重启，`bootAttempts` 会被记到一个从未被加载过的版本头上，回滚判定立刻失真。`staged` 让"已就绪"和"正在跑"保持可区分。

### 5.3 bootstrap loader

新增一个**不经过 vite 构建**的入口，`electron-builder.yml` 的 `extraMetadata.main` 指向它。它是整个方案中唯一不可热更新的部分。

```js
// src/bootstrap/index.mjs —— 打进 asar，永不参与热更新
import { app } from 'electron'
import { pathToFileURL } from 'node:url'

// Hot Update: 验签公钥硬编码在这里。它必须和验签逻辑一起待在 asar 内——
// 一旦公钥或验签代码可以被热更新替换，攻击者只要投一个包就能把验签换成空实现，
// 之后所有防护全部失效。这也是 bootstrap 不能由 vite 从 src/main 里打出来的原因。
const UPDATE_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\n…'

const entry = resolveActiveEntry() // §5.4 的状态机；失败时返回 asar 内置路径
await import(pathToFileURL(entry).href)
```

`resolveActiveEntry()` 必须**同步**完成并且绝不抛出——任何异常都要降级到 asar 内置版本。它运行在 `app.whenReady()` 之前，此时不能依赖任何业务代码。

> ⚠️ 这里依赖 §0.3 假设 1（ESM 动态 import 一个 bundle 外的 file:// URL）。若 PoC 不通过，改为把 main 打成 CJS 并用 `require()`。

### 5.4 启动确认与自动回滚（**最不能省的部分**）

```
启动
 ├─ state.baseVersion ≠ app.getVersion()？   → 清空 versions/，active = 0
 ├─ state.runtimeId  ≠ 宿主实际 runtimeId？  → 清空 versions/，active = 0
 ├─ bootAttempts ≥ 2？                       → 判定 active 是坏包
 │                                              active = confirmed，删除坏版本，记日志
 ├─ bootAttempts++ 并**立即写盘**
 └─ 加载 versions/<active>/main/index.js（active = 0 → asar 内置 out/main/index.js）

主窗口 did-finish-load
 └─ 起一个 10 秒定时器；期间无崩溃 → confirmed = active, bootAttempts = 0，写盘
```

设计要点：

- **`bootAttempts++` 必须在加载业务代码之前写盘**。如果放在之后，一个在 import 阶段就崩溃的包永远不会让计数器前进，回滚判定永远不触发，app 进入永久崩溃循环。
- **阈值取 2 而不是 1**：允许一次偶发失败（比如用户在启动瞬间强制关机）不误判为坏包。
- **确认延迟 10 秒**：太短会把"启动成功但 3 秒后崩"的包标记为好包；太长会让正常用户频繁停留在未确认状态。10 秒是经验值，可调。
- **`confirmed` 版本目录永不自动删除**，它是最后的退路。清理策略：保留 `active`、`confirmed` 和最近 1 个，其余删除。

### 5.5 路径为什么会自动跟随（Phase 0 已验证）

preload 与 renderer 都按模块自身位置相对定位：

- `src/main/window.ts` 的 preload 路径是 `join(moduleDir, '../preload')`
- 同文件的 renderer 是 `loadFile(join(moduleDir, '../renderer/index.html'))`

当 bootstrap 加载 `versions/h4/main/index.js` 时，`moduleDir` 自然是 `versions/h4/main`，preload 和 renderer 于是自动指向同一版本目录。**只要 `versions/<n>/` 与 `out/` 同构，这条链路不需要任何逻辑改动**——PoC 截图确认整个 UI（含 assets 与 preload）完整渲染。

但 Phase 0 暴露了一个必须改的写法：

> **`moduleDir` 必须是 `import.meta.dirname`，不能依赖 bundler 注入的 `__dirname`。**
> electron-vite 是否注入 `const __dirname = import.meta.dirname` 会随 external/bundle 配置变化。调整 `externalizeDepsPlugin` 的 `exclude` 之后注入就消失了，应用启动即 `ReferenceError: __dirname is not defined`，窗口都建不出来。`window.ts` / `tray.ts` 已改为 ESM 原生写法。

其余例外：

- `window.ts` 的 `join(moduleDir, '../resources/icon.png')` 是**兜底**路径，侧载后会失效。但主路径 `app.getAppPath()` 仍然有效（指向 asar），且 `resources/` 本来就在 `asarUnpack` 里不参与热更新，实测图标、托盘图标均正常。
- 约定：**`import.meta.dirname` 只用于定位 `out/` 内部的产物；访问 bundle 内资源一律用 `app.getAppPath()` / `process.resourcesPath`**，访问 bundle 内依赖用 §5.10 的 `nativeRequire`。

### 5.6 更新生命周期

§5.1–5.5 只描述了"启动时加载哪一份"。更新是怎么进来的是另一半：

```
idle ──检查(拉 manifest)──▶ 有新版? ──否──▶ idle
                               │是
                    downloading（下载到 staging/）
                               ▼
                        校验 sha256 + Ed25519
                          ├─失败─▶ 删除 staging，记录，回 idle
                          └─成功─▶ rename 进 versions/<n>/，state.staged = n
                               ▼
                            staged（可以停留很久，见 §5.7）
                               ▼
                   用户触发重启 ──▶ 启动时 active = staged, staged = null
                               ▼
                            §5.4 的启动确认状态机
```

- **检查时机**：启动后延迟 ~30 秒（避开启动高峰）+ 之后每 4 小时一次。`lastCheckAt` 做限流，防止托盘常驻进程反复轮询。**这个间隔直接决定 R2 免费额度能撑多少用户（§6.6），改小之前务必回看那张表**——改成 5 分钟会让天花板从约 4.7 万用户降到约 1150 人。
- **下载在主进程做**，不经渲染进程——渲染进程可能还没起来，且下载与 UI 无关。
- **整个过程对用户静默**，只有到达 `staged` 才提示一次。失败不打扰用户（§5.8）。

### 5.7 何时生效：与运行中的 turn 的冲突（**catmax 特有**）

大多数 Electron app 可以"下次启动自动生效"。catmax 不行，因为两个实测事实叠在一起：

1. **它是托盘常驻应用**。macOS 下 `window-all-closed` 不退出（`src/main/window.ts:209` 的注释明确写了这点），用户关掉窗口进程还活着。**"下次启动"可能是几周以后**，甚至永远不到——如果只被动等待，热更新等于没做。
2. **turn 可能跑很久，且重启无法恢复**。`DEFAULT_TURN_IDLE_TIMEOUT_MS` 是 30 分钟（`per-turn-coordinator.ts:7`），意味着一个正常的长任务可以持续很久而不算超时。而进程一旦重启，`recoverInterrupted()` 会把所有遗留的 `queued`/`running`/`cancelling` 强制标成 `interrupted`——**这是不可逆的**，本地 CLI/SDK 子进程已随主进程一起死掉，没有任何重连的可能。

两条合起来推出一条硬规则：

> **热更新绝不能自动重启进程。** 生效必须由用户显式触发，且触发前必须检查是否有活跃 turn。

具体要求：

- **需要新增 `PerTurnCoordinator.hasActiveTurns()`**。目前判断 `running`/`cancelling` 的逻辑散落在内部（`per-turn-coordinator.ts:228`、`:260`），没有对外的公开查询。更新模块需要它，不应该去遍历私有状态。
- **有活跃 turn 时，"立即重启"按钮置灰并说明原因**（"还有 N 个会话正在运行"），而不是弹一个"确定要中断吗"——用户在这个场景下几乎总会误点，而代价是不可恢复的。
- **重启走 `app.relaunch()` + `app.quit()`**，不能用 `app.exit()`。`quit` 才会触发 `src/main/index.ts:96` 已有的 `before-quit`，那里负责 dispose 后端和 bridge；`exit` 会跳过（`index.ts:17` 的注释正是为此存在）。
- **托盘菜单是最合适的入口**：它是这个常驻应用唯一always可达的 UI，窗口关掉时仍然在。

### 5.8 安装的原子性与失败处理

- **先下载到 `staging/`，校验通过后 `rename` 到 `versions/<n>/`**。同分区 rename 是原子的，因此 `versions/` 下永远不存在半个版本。反过来，直接解压进 `versions/` 会在断电时留下一个结构完整但内容残缺的目录，而 §5.4 的状态机无法分辨它。
- **解压前做磁盘空间预检**：需要约 `size × 3`（压缩包 + 解压后 + 余量）。空间不足直接放弃本次更新，不清理旧版本去腾地方——旧版本是回滚退路（§5.9）。
- **失败分级**：
  - 网络失败 / 超时 → 静默，下次检查再试，不提示用户
  - sha256 不匹配 → 传输损坏，删除重下一次，仍失败则放弃
  - **Ed25519 验签失败 → 这不是"损坏"，是投毒信号**。必须删除、停止本轮更新，并记入日志（将来若有遥测应上报）。绝不能像 sha256 那样"重试一次"
  - `hotVersion` ≤ 当前值 → 回滚攻击（§8.2），同样按投毒处理

### 5.9 磁盘占用与清理

每个版本约 14 MB（未压缩的 `out/`）。清理在**启动确认之后**执行，规则：

保留 `active`、`confirmed`、`staged`，以及最近的 1 个历史版本；其余删除。

**`confirmed` 永不自动删除**——它是 §5.4 回滚的落脚点，删掉它等于把回滚变成"退回 asar 内置版本"，用户会损失中间所有已验证的更新。

### 5.10 依赖解析：产物必须自包含（Phase 0 实测得出）

这一节是 PoC 的产物，原设计完全没有涉及。**它是整个路线 C 能否成立的地基**。

侧载执行时，`out/main/index.js` 位于 userData 下，而 ESM 的 bare specifier（`import 'simple-git'`）是按 **importer 所在目录**向上查找 `node_modules` 解析的。侧载位置那棵目录树里没有 `node_modules`，一路找到用户家目录仍然没有 → `ERR_MODULE_NOT_FOUND`，应用直接起不来。

三条实测结论决定了解法：

| 机制 | 能否跨到 asar 内的依赖 |
|---|---|
| ESM `import 'pkg'`（bare specifier） | ❌ 不能 |
| 侧载目录下建 `node_modules` 符号链接指向 asar | ❌ **无效**——ESM resolver 在 C++ 层实现，不走 Electron 给 `fs` 打的 asar patch |
| CJS `createRequire(app.getAppPath())` | ✅ **可以**，含 `app.asar.unpacked` 里的 `.node` 二进制 |
| 从侧载位置动态 `import()` asar 内的 ESM（绝对 file:// URL） | ✅ 可以 |

因此的策略是 **bundle 优先，shim 例外**：

- **纯 JS 依赖一律 bundle 进 `out/main/index.js`**（`electron.vite.config.ts` 的 `externalizeDepsPlugin({ exclude: [...] })`）。代价是产物从 640 KB 涨到 1.64 MB，压缩后约 +300 KB，对 4~5 MB 的热更新包可以接受。
- **无法 bundle 的走 `src/main/native/` 的 shim**，运行时用 `createRequire(join(app.getAppPath(), 'package.json'))` 从 asar 内取真包，再由 `resolve.alias` 把业务代码的 import 重定向过去。业务代码本身**零改动**。目前只有三个：`better-sqlite3`、`node-pty`（含 `.node` 二进制），以及 `@anthropic-ai/claude-agent-sdk`（运行时 spawn 平台二进制）。

三个坑，每个都实际踩到过：

1. **被 `externalizeDepsPlugin` 标成 external 的模块不会再走 `resolve.alias`**。所以那三个包也必须写进 `exclude` 列表，否则 alias 永远命中不了——bundle 进来的其实是 shim 本身，真包仍由 shim 在运行时取。
2. **`@anthropic-ai/claude-agent-sdk` 是纯 ESM 包**（入口 `sdk.mjs`），`require()` 会得到 `ERR_REQUIRE_ESM`。它的 shim 必须先 `nativeRequire.resolve()` 拿绝对路径（resolve 只查找不加载，对纯 ESM 同样有效），再用动态 `import()` 载入。这会让该 shim 成为异步模块，进而使整条 import 链异步——这是安全的，bootstrap 本来就是 `await import(entry)` 进来的。
3. **shim 的解析基点必须是 `app.getAppPath()`**，它在两种加载方式下都指向 app bundle。绝不能用 `import.meta.url`，那才是会跟着侧载位置漂走的东西。

**这条约束带来一个意外的好处**：热更新包不再依赖"asar 里恰好有哪些 node_modules"。新增一个纯 JS 依赖不必再发完整安装包——这扩大了热更新的适用范围，§3.4 的表格因此比原设计更偏向热更新一侧。但新增 native 依赖仍然必须发完整包（§4.3），且这类变更会改变 `runtimeId`（§7.3）。

**新增依赖时的判断**：默认加进 `exclude` 让它被 bundle；只有含 `.node`、或运行时 spawn 自带二进制、或有 bundler 静态分析不了的动态 require 时，才写 shim。每多一个 shim，热更新包就多一份对 asar 内容的运行时依赖，也就多一种宿主/热更新包版本错配的失败可能。详见 `src/main/native/README.md`。

### 5.11 Phase 1 实现说明（2026-08-07 完成）

落地的文件与职责划分：

| 文件 | 职责 | 是否进热更新包 |
|---|---|---|
| `src/bootstrap/state-machine.mjs` | **纯函数**决策：加载哪个版本、是否回滚、删哪些 | 否（asar 内） |
| `src/bootstrap/state-store.mjs` | `state.json` 原子读写、版本目录增删 | 否（asar 内） |
| `src/bootstrap/index.mjs` | 编排 I/O、启动确认、`await import(entry)` | 否（asar 内） |
| `scripts/compute-runtime-id.cjs` | 构建期算 `runtimeId` → `out/bootstrap/runtime-id.json` | 否 |
| `tests/bootstrap/state-machine.test.ts` | 16 个用例，穷举回滚分支 | — |
| `poc/hot-update/verify-rollback.sh` | 端到端验收（真打包、真启动、真崩溃） | — |

**决策逻辑独立成纯函数是有意的。** 回滚写错的后果不是"功能不好用"，而是坏包让所有用户永久打不开、且恢复逻辑本身也在坏掉的代码里。纯函数意味着可以用假数据穷举所有分支——包括那些端到端极难构造的：`confirmed` 自己也起不来、回滚目标目录被手动删除、`staged` 指向一个不存在的版本。

三个实现细节值得记：

1. **启动确认挂在 bootstrap 而不是业务代码里**。bootstrap 监听 `app.on('browser-window-created')` → `did-finish-load` → 10 秒定时器，业务代码对热更新完全无感，不需要知道自己是从 asar 还是 userData 跑起来的。
2. **`runtimeId` 必须写在 `out/bootstrap/` 而不是 `out/main/`**。后者会被热更新整个替换——一个能被热更新包自己改写的指纹起不到任何守门作用。另外算版本号时不能用 `require.resolve('<pkg>/package.json')`：现代包的 `exports` 字段会挡住它（`claude-agent-sdk` 实测返回 `missing`），那会让 SDK 升级时指纹纹丝不动，正好放过它本该挡住的事故。改为直读 `node_modules/<name>/package.json`，读不到就让构建失败。
3. **清理旧版本必须在确认之后**。确认之前 `confirmed` 还指向上一个版本，此刻按新状态清理会把回滚的落脚点删掉。

**只有无法 bundle 的依赖参与 `runtimeId`**（`better-sqlite3` / `node-pty` / `claude-agent-sdk`）。纯 JS 依赖已经打进热更新包里自带（§5.10），换了也不会和宿主冲突，算进指纹只会让它无谓地频繁变化、白白作废可用的热更新。

#### 验收记录

`verify-rollback.sh` 在真实打包产物上跑完整轨迹，全程无人工干预：

```
1/5 好包 h1 启动 → 10s 后确认 → confirmed=1
2/5 坏包 h2（main 第一行 throw）第 1 次启动 → 崩溃被兜住、本次降级到内置 → bootAttempts=1
3/5 第 2 次启动 → 仍尝试 h2（阈值为 2，允许一次偶发失败）→ bootAttempts=2
4/5 第 3 次启动 → 判定坏包 → 回滚到 h1、删除 h2 目录
5/5 再次启动 → 正常运行在 h1，tray/窗口俱在
```

---

### 5.12 Phase 3 实现说明（2026-08-07 完成）

| 文件 | 职责 |
|---|---|
| `src/bootstrap/index.mjs` | 新增 `injectHotUpdateHost()`：把验签能力经 `globalThis` 交给业务代码 |
| `src/main/service/hot-update-host.ts` | 读取注入、校验接口版本。**业务代码接触验签的唯一通道** |
| `src/main/service/hot-update.ts` | 检查 / 下载 / 验签 / 安装 / 调度 / 重启门禁 |
| `src/shared/ipc/update.ts` + `src/main/ipc/domains/update/` | 第 12 个 IPC domain |
| `src/renderer/src/stores/update.ts` + `components/sidebar/UpdateCard.vue` | 侧栏账号栏上方的更新卡片 |
| `src/main/tray.ts` | 托盘里的同一个入口 |

#### 验签能力必须由 bootstrap 注入，业务代码不能自己 import

这是 Phase 3 最大的结构性约束，而且是 **Phase 2 的安全断言逼出来的**：

`src/main/**` 里任何一处静态 `import` `signing.mjs` 或 `public-key.mjs`，vite 都会把公钥内联进 `out/main/index.js`——而那个文件正是热更新要替换的对象。等于公钥随热更新包一起下发，验签机制自我瓦解。`release-hot.mjs` 的内容级断言会当场拒绝这种包，所以这不是"最好别做"，是**根本发不出去**。

解法是让 asar 内的 bootstrap 在加载业务入口前挂上 `globalThis.__catmaxHotUpdate`，其中 `check()` 已经绑好公钥。业务代码只能问"这个更新能不能装"，拿不到公钥本身，也就不可能把它打进包里。顺带绕开了 §5.10 的坑：Electron 对 asar 的 fs patch 不覆盖 C++ 层的 ESM resolver，业务代码即便想在运行时 `import()` asar 里的 `signing.mjs` 也未必成功，而 bootstrap 早已加载过它。

实测确认 `out/main/index.js` 里既无公钥 base64，也无 `catmax-hot-update/v1`，`release-hot.mjs` 断言通过。

#### `apiVersion`：bootstrap 与业务代码之间的版本契约

**bootstrap 在 asar 内，热更新替换不了它**——这条在 §8.4 是安全属性，在这里则变成一个兼容性负担：两侧的版本会随时间分叉。一个用户完全可能 baseline 停在 0.1.0，却已经热更新到很久以后的 main 代码。

那份新 main 若直接调用一个老 bootstrap 还不存在的注入方法，后果不是功能缺失而是 **TypeError → 连续两次启动失败 → 回滚**，而且每次收到新版本都重演一遍——用户被永久钉死在旧版本上，且现象与"热更新坏了"无法区分。

所以注入对象带 `apiVersion`，`hotUpdateHost()` 比对 `REQUIRED_API_VERSION`，不满足就**返回 null 关闭热更新功能**。关闭是安全的降级：用户停在当前版本照常使用，只是收不到新更新；崩溃则会把他们锁死。

> ⚠️ 递增 `apiVersion` 等于宣告"老 baseline 从此收不到热更新"，只能靠发完整安装包救回来。**宁可给新能力设计一个可选的降级路径，也不要轻易递增。**

#### 重启门禁

`PerTurnCoordinator.countActiveTurns()` 是 §5.7 要求的公开查询（原本判断散落在私有状态里）。它下发的是**数量而不是布尔**，因为 UI 要说清"还有 N 个会话正在运行"——把按钮置灰却不说为什么，用户只会以为坏了。

门禁判定只有一份，在 main：renderer 拿到的是结论。两边各写一套规则迟早分叉，而分叉的代价是用户在有会话运行时重启，那些 turn 被 `recoverInterrupted()` 不可逆地标成 interrupted。`applyUpdate()` 在真正重启前**再查一次**——UI 的 `activeTurns` 是推送快照，用户点击那一刻完全可能已经有新 turn 开始了。

探针用注入（`setActiveTurnProbe`）而不是让 service 直接 import `backendManager`：更新服务只需要一个数字，反向依赖整个 backend 层会把它拖进 backend 的初始化顺序里。

#### 两个入口，因为窗口可以不存在

- **侧栏卡片**（账号栏正上方）：只在 `staged` 时出现。检查与下载全程静默（§5.6），没有"正在检查更新"的转圈——那对用户没有任何价值。
- **托盘菜单**：§5.7 说过托盘是这个常驻应用唯一 always 可达的 UI，窗口关掉后侧栏那张卡片就没了，而 macOS 下关窗进程还活着。没有待生效更新时**整段不出现**，而不是显示一个灰掉的项——托盘菜单常驻可见，一个永远灰着的项只会让人以为功能坏了。

#### 进程重启后要恢复 staged 状态

`staged` 记在 `state.json` 里，但内存状态在进程重启后是空的。`startHotUpdateScheduler()` 会从注入的 `stagedHotVersion` 恢复——不恢复的话卡片会消失，用户再也看不到"重启以更新"，而包已经躺在磁盘上了。

#### dev 模式自动关闭

`electron-vite dev` 直接跑 `out/main/index.js`，bootstrap 根本没参与，`hotUpdateHost()` 返回 null，整个功能静默关闭。开发时不该有热更新，这正是想要的行为；`supported: false` 让 renderer 完全隐藏入口，而不是显示一个永远点不动的按钮。

#### 验收记录（真实打包产物 + 真实 R2）

h2 经 `release-hot.mjs --publish` 发布到 R2，随后在一个全新安装、`hot-updates/` 为空的打包 app 上跑完整轨迹，全程无人工干预（点击"重启以更新"除外）：

```
07:27:51  启动 · 无 state.json · entry=…/app.asar/out/main/index.js   ← active=0，asar 内置
07:28:36  ✅ h2 已下载并验签通过，等待用户重启生效                      ← 启动后 45s 自动完成
          state: active=0 confirmed=0 staged=2 · versions/h2 就位 · staging/ 已清空
          UI:    侧栏账号栏上方出现「重启以更新 / 0.1.0 (h2)」卡片
07:29:28  启动 · 启用已下载的 h2 · entry=…/versions/h2/main/index.js   ← 点击卡片后
          state: active=2 confirmed=0 staged=null bootAttempts=1
07:29:38  ✅ h2 启动确认通过，已记为 confirmed                          ← 10s 稳定期
          state: active=2 confirmed=2 bootAttempts=0 · 卡片消失
```

同时验证：`out/main/index.js` 内既无公钥 base64 也无 `catmax-hot-update/v1`，`release-hot.mjs` 的内容级断言通过——注入方案确实避开了自己设下的陷阱。

---

## 6. 服务端

### 6.1 第一版不需要写任何服务端代码

客户端做的三件事——拉 manifest、比版本、下包——都不需要服务端参与决策。一个静态文件托管就是完整的第一版。

需要动态接口的只有三种情况，都可以后加：按用户灰度、更新率统计、紧急下架某个版本。

### 6.2 需要上传的文件

**完整包通道**（低频；第一期只发 mac，本地 `pnpm dist:mac` 后手工挂 Release，`zip` / `blockmap` / `latest*.yml` 等 electron-updater 相关产物暂不需要）

```
Catmax-0.1.0-arm64.dmg
Catmax-0.1.0-arm64.dmg.blockmap     ← 差分下载靠它，漏传则退化为全量
Catmax-0.1.0-x64.dmg
Catmax-0.1.0-x64.dmg.blockmap
Catmax-0.1.0-arm64-mac.zip          ← macOS 更新走 zip 不走 dmg（§0.2），需先加 zip target
Catmax-0.1.0-arm64-mac.zip.blockmap
Catmax-Setup-0.1.0-x64.exe
Catmax-Setup-0.1.0-x64.exe.blockmap
latest-mac.yml
latest.yml
```

**热更新通道**（高频；**第一期的重点**）

```
out/main/index.js       640 KB
out/preload/index.mjs    16 KB
out/renderer/**          14 MB
                    → 打成 h<N>.tar.gz，约 4~5 MB
```

**必须额外包含** `versions/<n>/package.json` = `{"type":"module"}`（两行）。没有它，Node 会把 `main/index.js` 当 CJS 解析，侧载必定 `SyntaxError` 失败（§0.3 实测）。

**绝不能进热更新包**：`node_modules`、**应用的** `package.json`、`resources/`、bootstrap 自身。注意与上一条的区别——禁止的是复制应用的 package.json（会带进 `main` 字段、`dependencies`、`version`），而上面那个只声明模块类型。

### 6.3 manifest 格式

静态 JSON，建议 `Cache-Control: max-age=300`：

```json
{
  "schema": 1,
  "channel": "stable",
  "latest": {
    "hotVersion": 4,
    "baseVersion": "0.1.0",
    "runtimeId": "a3f9c2e18b04",
    "url": "https://cdn.example.com/catmax/hot/0.1.0/h4.tar.gz",
    "size": 4823012,
    "sha256": "9f2c…",
    "signature": "MEUCIQ…",
    "mandatory": false,
    "releaseNotes": "修复会话标题回填",
    "releasedAt": "2026-08-06T15:04:05Z"
  },
  "history": [1, 2, 3, 4]
}
```

`history` 是**发布侧的账本，客户端不读**：R2 上还存在哪些包。它存在 manifest 里而不是本地文件，理由见 §6.6 的清理策略。

三个字段撑起整个协议的正确性：

- **`baseVersion`**：见 §7.2
- **`runtimeId`**：见 §7.3
- **`signature`**：Ed25519 签名。`sha256` 只防传输损坏，签名才防投毒，两者都要（§8）。
  **签名负载不止 `sha256`**——Phase 2 实现时收窄成同时覆盖 `hotVersion` / `baseVersion` / `runtimeId` / `sha256` 四个字段（§8.5）。只签 `sha256` 会留一个口子：攻击者可以把一个**真实签过名**的旧包重新挂到更高的 `hotVersion` 下，sha256 和签名都是真的，却能把有已知漏洞的旧版本推给已经升级的用户

按 `baseVersion` 分目录存放（`/hot/0.1.0/h4.tar.gz`），这样宿主版本迭代后旧包自然归档，不需要清理逻辑。

### 6.4 接口

**第一版：零接口**，两个静态 GET：

```
GET /catmax/hot/manifest.json
GET /catmax/hot/0.1.0/h4.tar.gz
```

**第二版（需要灰度/统计时）：一个 GET 就够**

```
GET /api/hot/check?base=0.1.0&hot=3&runtime=a3f9c2e18b04&platform=darwin&cid=<匿名UUID>

200 { "update": { …同 latest 结构… } }   有更新
204                                       已是最新
```

`cid` 是客户端本地生成、只用于灰度分桶的随机 UUID：服务端算 `hash(cid) % 100 < rolloutPercent`，同一台机器结果稳定，不会在"推送/撤回"之间反复横跳。

> ⚠️ 隐私边界：热更新检查是高频请求，`cid` **不得**关联任何真实用户标识，也不要顺手记录 IP + 时间戳做用户画像——那等于凭空建了一个行为日志库。只保留分桶所需的最小信息。

### 6.5 存储选型

| 用途 | 推荐 | 理由 |
|---|---|---|
| 完整安装包 | GitHub Releases | 仓库是 public（§0.1），Release 存储与流量全免费；低频下载，国内慢一点可接受 |
| 热更新包 | **Cloudflare R2** + 自定义域 | 出站流量免费。热更新是高频小包下载，放按流量计费的对象存储会被流量费咬 |

**不建议把完整安装包也放进 R2**：除了要自己维护 `latest*.yml`（electron-updater 的 `generic` provider 支持）之外，更实际的原因是体积——mac 双架构约 363 MB/版本，会把 10 GB 免费存储从"永远用不完"变成 27 个版本的硬上限（§6.6）。

> ⚠️ **当前仓库尚未配置 publish**，这与本文早期版本的描述相反：`electron-builder.yml` 没有 `publish` 段，`package.json` 没有 `repository` 字段，全仓也不存在 `app-update.yml`（§0.1 实测）。而 `dist/latest-mac.yml` 虽然存在，却只列了两个 dmg、`path` 也指向 dmg——`MacUpdater` 找的是 zip（§0.2），所以这份文件对自动更新是无效的。完整包通道落地时这三样都要补：`publish` 段、mac 的 `zip` target、以及由 `--publish` 重新生成的 `latest*.yml`。

---

### 6.6 R2 成本模型（2026-08-07 实测定价）

免费额度：存储 10 GB-月 · Class A 100 万次/月 · Class B 1000 万次/月 · **出站流量免费**。
超额：存储 $0.015/GB-月 · Class A $4.50/百万 · Class B $0.36/百万。

操作分类（Cloudflare 官方文档）：`PutObject` = **Class A**；`GetObject` / `HeadObject` = **Class B**；**`DeleteObject` 不计费**。

| 维度 | 本方案的实际用量 | 占免费额度 |
|---|---|---|
| **存储** | 热更新包 4~5 MB/个，保留 10 个 ≈ 50 MB | **0.5%**。用满 10 GB 需要约 2000 个包 |
| **Class A（上传）** | 每次发布 2 次 `PutObject`（tar.gz + manifest）。每月发 100 次 = 200 次 | **0.02%**，不可能用完 |
| **Class B（下载）** | 见下，**唯一需要认真算的维度** | 取决于轮询频率 |

**Class B 的构成**：包下载可以忽略（1000 用户 × 每月 4 次发版 = 4000 次，0.04%）。真正的消耗全在 manifest 轮询。按 §5.6 的策略（启动后一次 + 每 4 小时一次）估每用户每天 7 次、每月 ~210 次：

| 活跃用户 | Class B/月 | 占额度 |
|---|---|---|
| 100 | 2.1 万 | 0.2% |
| 1,000 | 21 万 | **2.1%** |
| 10,000 | 210 万 | 21% |
| ~47,000 | 1000 万 | 100%（临界点） |

**结论：几千用户以内完全免费，余量在 10 倍以上。** 即便超出，代价也极小——10 万用户约 2100 万次，超出的 1100 万次按 $0.36/百万 = **约 $4/月**。作为对照，同样流量放在按量计费的对象存储上，仅 egress 一项（10 万用户 × 4 次 × 5 MB ≈ 2 TB/月）就约 $180/月。**免费的出站流量才是选 R2 的真正理由，不是免费额度本身。**

#### 唯一会失控的参数：轮询频率

免费额度能撑多少用户，几乎完全由检查间隔决定：

| 检查间隔 | 每用户每月请求 | 用满 1000 万需要 |
|---|---|---|
| **4 小时**（§5.6 采用） | ~210 | ~47,000 用户 |
| 1 小时 | ~750 | ~13,000 用户 |
| 5 分钟 | ~8,640 | **~1,150 用户** |

把间隔从 4 小时改成 5 分钟，天花板下降 40 倍——1000 用户就会触顶。这是这个方案里唯一一个"改一个常量就让成本量级变化"的地方，改动 §5.6 的轮询间隔时必须回看这张表。

#### 关于 CDN 缓存：小用户量下不要做

直觉上应该给 manifest 加边缘缓存让回源次数与用户数脱钩。但在本项目的量级下这**可能适得其反**：缓存回源次数正比于活跃 PoP 数量而非用户数，`max-age=300` 下每个 PoP 每月约回源 8600 次，几十个 PoP 就是几十万次——比 1000 用户直接打 R2（21 万次）还多。

所以：**几千用户量级直接回源 R2 即可**，用户量真正上万后再评估分层缓存（Tiered Cache）。

不过自定义域仍然必须绑，理由与缓存无关：**`r2.dev` 公共 URL 被官方明确限速且仅供开发使用**，不能用于生产分发。

> ⚠️ 待验证：官方文档确认自定义域启用 Cloudflare 缓存，但**未明说缓存命中是否免计 Class B**。技术上边缘命中不回源即不产生 R2 操作，但这是推断。真要依赖它时，对比 R2 dashboard 的 Class B 计数与实际请求数即可证实。

#### 版本保留策略

R2 支持三种清理方式，各有边界：

| 方式 | 命令 | 限制 |
|---|---|---|
| 发布脚本删除（**推荐**） | `wrangler r2 object delete` | 无限制，且 `DeleteObject` **免费** |
| Lifecycle 规则 | `wrangler r2 bucket lifecycle add <bucket> <name> <prefix> --expire-days N` | **只能按天数，无法表达"保留最近 N 个"** |
| 按 `baseVersion` 分目录 | 已在 §6.3 设计（`/hot/0.1.0/`） | 宿主版本迭代后整目录自然归档 |

**但不要为了省钱激进删除——存储只占 0.5%，删了一分钱也省不下。** 保留策略真正要服务的是另一件事：

> **服务端紧急回滚（下架坏版本）要求旧包仍在 R2 上。** 若 h5 被发现是坏包，处置方式是把 manifest 改回指向 h4——此时 h4 的 tar.gz 必须还能下载。删得太狠会让这个动作直接失效。

注意区分：§5.4 的**客户端本地回滚**读的是 `versions/` 下的本地目录，不需要服务器上的包。所以删除旧包**不影响本地回滚**，它唯一损害的就是服务端下架能力。

推荐：**保留最近 10 个版本，下限 3 个。** 发布脚本删除前必须校验目标不是 manifest 当前引用的版本。

> ⚠️ **wrangler 4.119 没有 `r2 object list`**（实测：`r2 object` 只有 `get`/`put`/`delete`），所以"远端有哪些包"无法枚举，上表推荐的"发布脚本删除"必须自带账本。
>
> 账本放在 **manifest 的 `history` 字段**里，而不是本地文件——`release/` 在 `.gitignore` 内，本地账本一旦随目录丢失，清理能力会跟着一起消失且无法重建；manifest 在 R2 上有权威副本，随时能拉回来。客户端不读这个字段，代价是每次轮询多传十几个数字。
>
> 选择逻辑抽成了纯函数 `remoteVersionsToPrune()`（`scripts/hot-update-config.mjs`）并单测覆盖，因为它的删除分支**只在版本数超过 10 时才会执行**——真实发布跑很多次都碰不到，等碰到时已经发出去了。测试里专门覆盖了"manifest 指向一个很旧的版本"（服务端下架后的状态），此时那个包绝不能被"它很旧"这条规则误删。

**完整安装包不要放进 R2。** mac 双架构合计约 363 MB/版本，10 GB 只够 27 个版本——与热更新包放在一起会让存储从"永远用不完"变成需要主动管理的资源。它们属于 GitHub Release（§6.5），那里对 public 仓库不限量。

---

## 7. 版本模型

### 7.1 双版本号

- **宿主版本** = `package.json` 的 `version`，只在发完整安装包时递增（0.1.0 → 0.2.0）
- **热更新版本** = 独立递增的整数 `hotVersion`，语义是"基于宿主 0.1.0 的第 N 次热更新"
- 用户可见版本可以拼成 `0.1.0 (h4)`

**不要让热更新去推进宿主的语义化版本号。** 一旦热更新把版本从 0.1.0 推到 0.1.5，"用户重装了 0.1.0 的 dmg，但本地热更新到了 0.1.5"这个状态就没法干净表达——到底该不该再应用一次热更新？两个 0.1.5 是同一份代码吗？双版本号从根上避免了这个问题。

### 7.2 `baseVersion` 守门

宿主启动时比对 `state.baseVersion` 与 `app.getVersion()`：

- 相等 → 正常加载 `active`
- 不等 → 用户装了新的完整包，**清空所有热更新版本，从 asar 内置重新开始**

没有这道门，用户升级完整包后会被旧的热更新代码覆盖，出现"装了新版却还是老界面"的诡异状态，且极难排查。

### 7.3 `runtimeId` 守门

由构建时的 native 环境算出的指纹：

```
runtimeId = sha256(
  electronVersion + '|' +
  sortedJoin(dependencies 的实际解析版本)   // better-sqlite3, node-pty, claude-agent-sdk …
).slice(0, 12)
```

构建时写进 asar 内的一个小 JSON（例如 `out/runtime-id.json`），运行时读出来与 manifest 比对，不一致则拒绝应用该热更新包。

它挡的是 §4.3 描述的事故。**版本号范围（`minAppVersion`/`maxAppVersion`）表达不了这个约束**——native 依赖可以在宿主版本号不变的情况下变化，反过来宿主版本号变了 native 也可能完全没动。一个显式指纹比版本区间更准确，也更难写错。

---

## 8. 安全

### 8.1 威胁模型

热更新等于**绕过操作系统的代码签名机制去执行远程代码**，而 catmax-app 拥有：pty（任意命令执行）、完整文件系统访问、用户的 API key 与 `~/.codex/auth.json` 的编辑能力。

因此：**更新服务器被攻破 = 全部用户机器被 RCE。** 这不是夸张的假设，是这个方案引入的真实攻击面，必须用密码学而不是运维纪律来兜底。

### 8.2 三条不可省的措施

1. **Ed25519 签名验证**。`node:crypto` 原生支持（`generateKeyPairSync('ed25519')`），无需第三方库。私钥**离线保管**，不放进 CI 环境变量——本地签名后再上传产物。公钥硬编码在 bootstrap 里（§5.3）。
2. **HTTPS + 证书校验**，不接受任何降级或自签名。
3. **`hotVersion` 单调递增**，拒绝小于等于当前值的版本。否则攻击者可以重放一个有已知漏洞的旧包（回滚攻击）。

### 8.3 验签的时机

- **安装时**：完整验签（sha256 + Ed25519），通过才 `rename` 进 `versions/`
- **启动时**：不重复验签。4 MB 文件算哈希要几十毫秒，每次启动都付这个代价不值得

这个取舍的前提是：能写 `userData` 的攻击者通常已经具备更直接的攻击手段（改用户的 shell 配置、直接读 API key），启动时重复验签挡不住他。CodePush / Expo 的做法也是安装时验签。

### 8.4 不可热更新的边界（必须守住）

**bootstrap、验签逻辑、公钥三者必须都在 asar 内**，且热更新包不得包含它们。发布脚本应当在打包热更新包时**主动断言**这三样不在包里——一旦它们可以被热更新替换，整个签名机制等于不存在。

### 8.5 Phase 2 实现说明（2026-08-07 完成）

| 文件 | 职责 |
|---|---|
| `scripts/generate-signing-key.cjs` | 生成 Ed25519 密钥对；私钥 → `~/.catmax/`（0600），公钥 → `src/bootstrap/public-key.mjs`（进仓库） |
| `src/bootstrap/signing.mjs` | `signingPayload()` / `verifySignature()` / `checkUpdate()`，**发布侧与客户端共用** |
| `scripts/release-hot.mjs` | 打包 + 断言 + 签名 + 递增 `hotVersion` + 生成待发布 manifest（不联网） |
| `scripts/publish-hot.mjs` | 上传 R2 + 逐步回读验证 + 清理旧包（§9.4 说明为什么与上一行分开） |
| `scripts/hot-update-config.mjs` | bucket / 域名 / key 前缀 / 保留策略，两个脚本共用以防 URL 与 object key 漂移 |
| `tests/bootstrap/signing.test.ts` | 14 个用例，重点是每种该拒绝的输入都确实被拒绝 |
| `tests/bootstrap/remote-prune.test.ts` | 7 个用例，全是构造出来的越界场景（正常发布跑不到删除分支） |
| `poc/hot-update/install-local.mjs` | 按真实安装流程从本地 `release/` 装包，同时是 Phase 3 安装器的原型 |

**签名负载由两侧共用一个 `signingPayload()`。** 各写一份"拼接待签字符串"的代码迟早会因字段顺序或分隔符不一致而漂移，表现为"签名明明是对的却验不过"——这种故障极难排查。格式是固定顺序的逐行拼接而非 JSON：JSON 的键顺序和空白在不同实现下不稳定，而签名对字节级差异零容忍。

**安全断言分两层，第二层是 Phase 2 补的。** 第一层按文件名拦 `bootstrap` / `node_modules` / `public-key.mjs` / `signing.mjs` / `runtime-id.json`。但它只能抓"以独立文件混入"的情况——**只要有人在 `src/main/**` 里 import 了 `public-key.mjs`，vite 就会把公钥内联进 `out/main/index.js`，文件名一个都匹配不上**，而热更新包从此带着一份可被替换的公钥副本。所以第二层按**内容**搜公钥 base64 前缀和 `catmax-hot-update/v1` 这两个特征串。三种违规场景都实测拦截成功（独立文件混入、node_modules 混入、公钥被 bundle 进 index.js）。

**`checkUpdate` 区分两类失败**：`poisoned: false` 是传输损坏（sha256 不匹配、baseVersion/runtimeId 不符），可以重下；`poisoned: true` 是投毒信号（验签失败、`hotVersion` 未递增），必须停止本轮更新并记录，**绝不能像 sha256 那样"重试一次"**。

#### 实测数据

- 热更新包 **3.09 MB**（tar.gz），比 §6.2 估的 4~5 MB 更小
- 端到端闭环已跑通：`release-hot.mjs` 签名 → `install-local.mjs` 验签并解压到 `versions/` → 写 `state.staged` → 重启后 bootstrap 提升 `staged → active` → 10 秒确认 → `confirmed`
- **h1 已真实发布到 R2 并公网验证**：`curl` 下载回来的包 sha256 与本地签名对象逐字节一致（`e99bf659…b05cb6`），`content-type: application/gzip`、`cache-control: public, max-age=31536000, immutable`；manifest 返回 `max-age=300`。**发布链路上没有任何环节改动过被签名的字节**——这是验签能在客户端成立的前提
- 顺带印证了 `url` 不在签名负载的设计：给一个已签名的 manifest 补上 `url` 字段后，`checkUpdate()` 依然通过
- tar 打包加了 `--no-xattrs` + `COPYFILE_DISABLE=1`：macOS 的 bsdtar 默认塞进 `._*` AppleDouble 文件和扩展属性，会让相同输入产出不同字节

---

## 9. 发布流程与自动化

### 9.1 判定走哪条通道

```
pnpm build
  ↓
计算 runtimeId（electron 版本 + dependencies 解析版本）
  ↓
与上次发布的 runtimeId 比较
  ├─ 不同 → 只能发完整安装包
  │         pnpm dist → 上传 dmg/exe/zip/blockmap/latest*.yml
  │         hotVersion 归零，baseVersion 递增
  └─ 相同 → 可以发热更新
            tar czf h<N+1>.tar.gz -C out main preload renderer
            断言包内无 bootstrap / node_modules / package.json
            sha256 → Ed25519 签名（离线私钥）
            上传 tar.gz → 更新 manifest.json（manifest 最后更新，保证包先就位）
```

**manifest 必须最后上传**：先更新 manifest 再传包，会有一个时间窗口内客户端拿到指向 404 的 URL。

#### 发完整安装包时必须同步处理线上 manifest（2026-08-07 实测踩到）

新 baseline 与线上热更新包的 `baseVersion` / `runtimeId` 若都相同，**新装的用户会在 30 秒后立刻被"更新"成线上那个包**——而它完全可能比 baseline 还旧。守门一条都拦不住：`baseVersion` 相同、`runtimeId` 相同、`hotVersion > active(0)`，全部放行。

实测正是这样：Phase 3 的 baseline 打好时，线上还挂着一个更早的 h2，新用户装完会被回退一个提交。所以发完整安装包时，线上 manifest 必须一起处理，三选一：

| 做法 | 适用 |
|---|---|
| **清空 manifest** | 线上的包只是测试产物、没有真实用户。客户端检查得到 404 → 静默失败 → 保持 idle，是安全路径 |
| 用 baseline 的代码发一个新 hotVersion | 已有用户停在旧 baseline，需要他们继续收到更新 |
| 递增 `baseVersion` | 本来就该升版本号时。`baseVersion` 守门会自动拒绝旧包（§7.2），无需动 R2 |

#### 删除的顺序是发布顺序的镜像

发布是"先传包、最后传 manifest"，**删除就必须"先删 manifest、再删包"**。反过来会留下一个窗口：manifest 还指向已被删除的包，期间所有客户端下载 404。

> ⚠️ **删除 R2 对象不等于立刻下架。** tar.gz 带 `immutable` 缓存头，实测删除后边缘仍以 `cf-cache-status: HIT` 继续供包（`age` 已累计数小时），只有带 cache-buster 才看到源站的 404。
>
> 所以**紧急下架一个坏包，靠删包是不可靠的**——正确手段是把 manifest 改回指向旧版本（§6.6），因为 manifest 只有 `max-age=300`，五分钟内全网生效。这也解释了为什么旧包必须保留：下架动作依赖的是"改 manifest 指向一个仍能下载的旧包"，不是"让坏包下载不到"。

### 9.2 自动化分工：完整包通道进 CI，热更新通道留在本地

> 📌 **第一期决定（2026-08-07）：只做 macOS，只做热更新通道，全部在本地发布。** 完整包通道与 GitHub Actions 推迟到需要分发 Windows 时再做（§9.3 保留调研结论备用）。
>
> 这个收缩比表面上更划算：mac 上 electron-updater 本来就跑不起来（未签名，§0.2），CI 的主要价值是产出**本机做不出来的 Windows 包**——不发 Windows，CI 就失去了它唯一不可替代的作用。mac 的完整安装包继续由本地 `pnpm dist:mac` 产出、手工挂到 GitHub Release 即可，频率是数月一次。
>
> 需要澄清的是**这不是成本决定**：仓库是 public（§0.1），GitHub-hosted runner 含 macOS 不消耗任何额度。推迟纯粹是范围选择。

下面的分析在将来恢复 Windows 分发时仍然成立。直觉上"尽量自动化"等于"全都塞进 CI"，这里恰恰相反，两条通道的成本结构完全不同：

| | 完整包通道（完整安装包） | 热更新通道（热更新包） |
|---|---|---|
| 频率 | 数月一次 | 每次发版 |
| 构建内容 | native 重编译 + 打 dmg/exe + 处理 256 MB 二进制 | 只跑 `electron-vite build`，产出 14 MB 纯 JS |
| 耗时 | 十几到二十几分钟 | 数十秒 |
| **必须多平台** | **是**——native 模块要在目标平台编译，mac 上做不出 Windows 包 | 否，纯 JS 与平台无关 |
| **需要私钥** | 否 | **是**（Ed25519，§8.2） |
| **结论** | **全自动 CI** | **本地一条命令** |

完整包通道进 CI 是**能力问题而不是省力问题**：`pnpm dist:win` 在这台 mac 上根本跑不出可用的 Windows 包（better-sqlite3 / node-pty 是编译产物），这也是 `dist/` 里至今只有两个 dmg 的原因。CI 的 matrix 是唯一能同时产出 mac + win 的途径。而它恰好**不需要任何密钥**——mac 是 ad-hoc 签名，CI 上 electron-builder 会自动完成；上传 Release 用的 `GITHUB_TOKEN` 由 Actions 自动注入。零密钥的流水线可以放心全自动。

热更新通道留在本地则是因为把它搬进 CI 是一笔亏本交易：本地几十秒能完成的事，走一趟 CI 要推 tag、排队、拉 2 GB 依赖，**更慢**；而代价是私钥必须交给 GitHub Secrets（§9.5）。纯 JS 产物在哪台机器构建结果都一样，没有"必须在干净环境构建"的理由。

发布者实际感受到的操作是：改完代码 → `pnpm release:hot` → 结束。这已经没有可优化的空间。

### 9.3 完整包通道：GitHub Actions（**第一期不做，结论备查**）

仓库是 **public**（§0.1），因此 GitHub-hosted runner（含 macOS）不消耗任何额度——若是 private 仓库，macOS 按 10× 计费，Free plan 的 2000 分钟大约十次构建就会耗尽，那时结论会不同。

`.github/workflows/release.yml` 的骨架：tag `v*` 触发 → matrix `[macos-latest, windows-latest]` → checkout / pnpm / setup-node → `pnpm install` → `pnpm dist:mac` 或 `dist:win` `--publish always` → 汇总为一个 GitHub Release。

四个这个项目特有的坑：

1. **必须 cache pnpm store**。`pnpm.supportedArchitectures` 声明了 darwin + win32 × x64 + arm64，于是**每个** runner 都会拉全部平台的 claude 包（每个 245~254 MB，合计接近 2 GB）。不做缓存的话光 install 就十几分钟。
2. **先补 `publish` 段**。当前 `electron-builder.yml` 没有它（§0.1），`--publish` 无从下手。
3. **mac 要补 `zip` target**。否则完整包通道在 mac 上永远不可用（§0.2），Actions 跑通了也没有意义。
4. **x64 的 native 模块不用额外处理**。runner 是 arm64，但 electron-builder 的 `npmRebuild` 会在打 x64 包时自行重建——本机已经这样产出过 x64 dmg，CI 上同理。

### 9.4 热更新通道：两段式，`release-hot.mjs` + `publish-hot.mjs`

**实现时拆成了两个脚本，与本节早先"一个脚本串到底"的写法不同。** 理由是两段的失败语义相反：

| | `release-hot.mjs`（签名） | `publish-hot.mjs`（传输） |
|---|---|---|
| 失败性质 | 异常。断言不过说明代码有问题 | **常态**。网络抖动、token 过期 |
| 正确的重试方式 | 修好问题重跑，产出新字节 | 原地重试，**不得改变任何已签名的字节** |
| 联网 | 否 | 是 |

合成一个脚本就必须在"重试"时决定要不要重新打包，而重新打包会换掉 sha256——"重试上传"于是变成了"发布另一个包"。拆开之后 `publish-hot.mjs` 可以无限次原地重跑。

```bash
pnpm release:hot --notes "..."      # 打包+签名 → release/manifest.pending.json
pnpm publish:hot                    # 上传 → release/manifest.json
pnpm release:hot --notes "..." --publish   # 一次做完
```

**`manifest.json` 与 `manifest.pending.json` 的区分是版本号幂等性的基础。** 前者的语义是"已成功发布到 R2"，后者是"已签名但没传上去"。`hotVersion` 从**已发布**的那份推导，所以上传失败后重跑 `release-hot.mjs` 会复用同一个版本号；若从单一 manifest 推导，每失败一次就烧掉一个版本号，manifest 的 `history` 里会留下永远不存在于 R2 的空洞版本，而 §6.6 的服务端下架恰恰依赖"旧包还在"。

> ⚠️ **`--remote` 必须显式写。** wrangler 4 的 `r2 object put` 同时提供 `--local` 与 `--remote`，缺省走本地 `.wrangler/state`。漏掉这个 flag 会得到一次"成功"的上传，而云端什么都没有。
>
> ⚠️ **`-y` 也必须写。** `put`/`delete` 都有一个 data catalog 校验提示，非交互环境下（脚本、CI、agent）会挂在等待输入上，表现为发布"卡住"而不是失败。

`publish-hot.mjs` 不信任 wrangler 的退出码，每一步都回读公网验证：包传完先 `HEAD` 确认 200 且 `content-length` 与 manifest 一致，**之后才允许更新 manifest**；manifest 传完再 `GET` 回来比对 `sha256`/`hotVersion`。这样 §9.1 那句"manifest 最后上传"才真正成立——否则包传失败时 manifest 仍会被更新，指向一个 404。

它还有两道拒绝上传的前置检查：**tar.gz 与 manifest 的 sha256 对不上**（说明包在签名后被改过，上传等于发布一个全体客户端必定验签失败的版本），以及 **`CLOUDFLARE_API_TOKEN` 未设置**（详见 §9.5，绝不静默回退到 OAuth）。

#### 本地用 Agent 发布：可以，但要划清哪一半

第一期采用**本地 Agent 驱动发布**（不写完整的一键脚本，也不进 CI）。这在发布流程尚未定型的早期是对的选择——脚本写早了每次都要改。但有一条边界不能模糊：

| 步骤 | 谁做 | 为什么 |
|---|---|---|
| 打包 `out/` → tar.gz | **脚本** | 需要每次字节级一致 |
| 断言包内无 bootstrap / `node_modules` / `package.json` | **脚本** | §8.4 的安全边界。漏一次，签名机制即失效 |
| sha256 + Ed25519 签名 | **脚本** | 私钥操作，必须幂等且可测试 |
| `hotVersion` 递增 | **脚本** | 单调性是防回滚攻击的前提（§8.2） |
| 上传 R2、回读校验 | **脚本**（原计划 Agent） | 见下 |
| 删除旧包 | **脚本** | 删错 = 全体客户端 404 且下架能力消失（§6.6） |
| 撰写 `releaseNotes` | Agent / 人 | 本来就需要判断 |
| 出错时诊断 | Agent | 正是它擅长的 |

**"上传 + 回读校验"在实现时从 Agent 挪到了脚本**，与本表早先的划分不同。原本的理由是"需要处理网络异常、确认公网可达"听起来像判断题，但真正写下来才发现它全是死规则：先传包后传 manifest、HEAD 校验 200 与 content-length、失败则**不得**更新 manifest。这些没有一条需要判断，而漏掉任何一条的后果都是线上 manifest 指向 404。让 Agent 每次现写这段，等于每次重新赌它不漏——这与断言必须进脚本是同一个理由。

Agent 剩下的位置是**发布之外**：决定这次该不该发、写 notes、出错时诊断。

换句话说：**安全相关的步骤必须是确定性脚本**，Agent 负责调用它、以及之后需要判断的部分。理由不是不信任 Agent，而是这些步骤的正确性不能依赖每次生成的代码恰好一致——`--remote` 漏写只是发布失败，断言漏写是**静默地**把验签机制掏空。

Cloudflare 技能在这里还有一个不可替代的用途：**一次性基础设施搭建**——创建 bucket、绑自定义域、生成最小权限 API token、验证公网可达。这类有判断、只做一次的工作交给它最合适（§11.7）。

### 9.5 密钥与基础设施

| 密钥 | 存放 | 谁用 |
|---|---|---|
| `GITHUB_TOKEN` | Actions 自动注入 | 完整包通道的 CI，无需配置 |
| Cloudflare API Token | 本地 `~/.wrangler` 或 shell 环境 | 热更新通道的本地脚本 |
| **Ed25519 私钥** | **仅本地，离线保管** | 热更新通道的签名 |

Cloudflare API Token 必须是 **scoped token**（仅 `Workers R2 Storage:Edit`，限定到目标 bucket），不要用 Global API Key——后者能操作账号下的一切，包括 DNS。

> ⚠️ **当前 token 是 account 级 R2，不是 bucket-scoped（2026-08-07）**。实测验证（§9.5 末尾）：它能 `GET /accounts/.../r2/buckets` 列出账号下所有 bucket，所以权限范围是 account 级而非 bucket 级。**但碰不了 DNS（403）也碰不了 Workers Scripts（403）**——关键安全边界守住，能力上限是"操作账号下的 R2"。当前账号下只有 `catmax-updates` 一个 bucket，所以实际暴露面与 bucket-scoped 等价。**触发重建的条件：一旦在这个账号下为别的项目新建任何 R2 bucket，必须立即重建为 bucket-scoped**（Bucket Resources → Include → Specific bucket → `catmax-updates`），否则旧 token 会顺手也能写新 bucket。重建前不要部署新的 R2 bucket。

#### R2 基础设施（2026-08-07 已搭建）

一次性基础设施已就位（用 `wrangler login` 的 OAuth 完成，非 scoped token——scoped token 仅用于发布脚本，见最后一段）：

| 项 | 值 | 备注 |
|---|---|---|
| bucket | `catmax-updates` | location hint `WNAM`，default storage class Standard |
| 自定义域 | `hot.toolpie.dev` | 绑定到 `catmax-updates`，SSL 已 active，min TLS 1.2 |
| zone | `toolpie.dev`（`5edcb4a667efcea850c2ae2f5f2bc2ee`，active） | 在 `shawn525686@gmail.com` 账号下 |
| 账号 ID | `b626b3b010029fe29ee4e080679eddde` | |
| 公网路径约定 | `https://hot.toolpie.dev/catmax/hot/manifest.json`<br>`https://hot.toolpie.dev/catmax/hot/<baseVersion>/<file>.tar.gz` | bucket 内 key 不含前导 `/`；URL 路径含 `/catmax/` 前缀 |

> **当前 bucket 状态（2026-08-07）：已清空。** Phase 2/3 期间发布的 h1、h2 都是测试产物且无真实用户，在 0.1.0 baseline 打包完成后一并删除（含本地 `release/` 账本），使这个 baseline 成为干净起点——理由见 §9.1 的"发完整安装包时必须同步处理线上 manifest"。所以线上现在没有 manifest，客户端检查得到 404、静默保持 idle。下一次热更新从 h1 重新开始。

实测验证（2026-08-07）：上传一个最小 manifest 到 `catmax/hot/manifest.json` 后 `curl https://hot.toolpie.dev/catmax/hot/manifest.json` 返回 `HTTP/2 200` + 正确 `content-type: application/json` + `cache-control: no-cache`，`cf-ray: ...-LAX` 从美西 PoP 回源（符合 §6.6 预期）。验证后已删除该测试对象，bucket 现为空。

**关于 `wrangler r2 bucket domain add`**：4.119.0 不会从域名推断 zone，必须显式给 `--zone-id`（可在 dash 或 `GET /zones?name=` 取，后者复用 OAuth token 即可）。`--min-tls 1.2` 顺手设上——热更新是机器读静态 JSON，无兼容老浏览器的负担。

**发布 token（2026-08-07 已建并验证）**：已通过 `~/.zshrc` 的 `CLOUDFLARE_API_TOKEN` 注入（长度 53，前缀 `cfut_`，不过期）。`wrangler` 会自动读这个环境变量，无需在命令里显式传。实测能力边界：

| 操作 | 结果 |
|---|---|
| `wrangler r2 object put catmax-updates/...` | ✅ Upload complete |
| `GET /accounts/.../r2/buckets`（列所有 bucket） | 200，可见 `catmax-updates`——**account 级，非 bucket-scoped** |
| `GET /zones/<id>/dns_records`（读 DNS） | **403** |
| `GET /accounts/.../workers/scripts`（读 Workers） | **403** |

→ token 碰不了 DNS 也碰不了 Workers，能力上限是操作账号下的 R2。账号下当前只有 `catmax-updates` 一个 bucket，等价于 bucket-scoped（见上面那条告警的重建条件）。

> ⚠️ **token 写在 `~/.zshrc` 里，只有交互式 shell 读得到。** zsh 的非交互调用只加载 `~/.zshenv`，所以从脚本、CI、或 agent 的工具 shell 跑发布脚本时 `CLOUDFLARE_API_TOKEN` 是空的。这个失败很隐蔽：**wrangler 不会报错，它会静默回退到 `~/.wrangler` 的 OAuth 凭据然后成功上传**——而那是账号全权凭据（能删 bucket、改 DNS、部署 Worker），正是 scoped token 想避免的东西。发布看起来一切正常，权限边界却悄悄失效了。
>
> 所以 `publish-hot.mjs` **硬性要求这个环境变量存在，宁可失败也不回退**。要让非交互环境也能发布，把它挪到 `~/.zshenv`，或显式传入 `CLOUDFLARE_API_TOKEN=... node scripts/publish-hot.mjs`。

如果将来确实需要热更新通道也全自动（例如希望在手机上点一下就发版），代价必须明说：**Ed25519 私钥进入 GitHub Secrets，意味着 GitHub 账号被攻破或 Actions 供应链被污染 = 可以向全部用户投递任意代码**。对一个持有 pty、文件系统访问和用户 API key 的 app，这不是理论风险。真要做，至少配合 environment protection rule 要求人工审批——但那时"自动化"带来的便利已所剩无几，不如维持本地签名。

---

## 10. 实施阶段

**第一期目标：macOS + 热更新通道 + 本地发布。** Windows 与 GitHub Actions 移出第一期（§9.2）。

| Phase | 内容 | 验收标准 | 依赖 |
|---|---|---|---|
| ~~**0**~~ | ~~PoC 验证 §0.3 的三条假设~~ | ✅ **2026-08-07 完成**：三条全部成立，架构保留；产出 §5.10 这条原设计没有的约束 | — |
| ~~**1**~~ | ~~bootstrap + 状态机 + 回滚，完全不联网~~ | ✅ **2026-08-07 完成**：16 个单测 + 端到端回滚验收（`poc/hot-update/verify-rollback.sh`）全部通过 | Phase 0 |
| ~~**2**~~ | ~~发布侧：签名 + 发布脚本 + R2 基础设施~~ | ✅ **2026-08-07 全部完成**。离线部分见 §8.5，R2 基础设施与 token 见 §9.5，两段式发布脚本见 §9.4。**h1 已真实发布上线**：`https://hot.toolpie.dev/catmax/hot/manifest.json`，下载回来的字节 sha256 与本地签名对象逐字节一致 | — |
| ~~**3**~~ | ~~客户端联网：检查 / 下载 / 验签 / 安装 + 托盘入口 + 活跃 turn 门禁~~ | ✅ **2026-08-07 完成**（§5.12）。**在真实打包产物上端到端跑通了一次完整热更新**，记录见下 | Phase 1, 2 |
| **4**（可选） | 灰度接口、更新进度 UI、文件级增量 | — | Phase 3 |
| **推迟** | 完整包通道：`publish` 段 + mac `zip` target + Actions + Windows | 需要分发 Windows 时再启动（§9.3） | — |

**Phase 1 必须先于 Phase 3。** 回滚机制没有单独验证过就上线热更新，等于把所有用户的 app 押在"发布流程永不出错"上。验收方式是手动构造一个坏包（`main/index.js` 第一行就 `throw`），确认它连续启动失败两次后自动退回 `confirmed` 版本——**这一步必须在任何联网代码存在之前完成**，否则一旦发出去就没有回头路。

**Phase 2 可以与 Phase 1 并行**，它不依赖客户端任何代码。先做它的好处是能尽早暴露 R2 配置、自定义域、公网可达性这些外部依赖问题——这些卡住的时间通常比写代码长。

Phase 3 的 `hasActiveTurns()` 门禁不是 UI 打磨，是 §5.7 的硬要求，不能推到 Phase 4。

---

## 11. 未决问题

1. **§0.3 的三条假设未验证**，Phase 0 的结论可能推翻 §5.3 的 ESM loader 设计。
2. **macOS 是否购买开发者签名**尚未决定。买了则完整包通道在 mac 上解锁，本方案不受影响（路线 C 不碰 bundle）；不买则热更新是 mac 唯一的自动更新路径，§5.4 的回滚机制的重要性进一步上升。
3. **`out/renderer` 还有 14 MB 可压缩空间**：shiki 把所有语言的高亮规则全量打进去了（`emacs-lisp` 804 KB、`cpp` 697 KB、`wasm` 622 KB、`wolfram` 268 KB…）。改成按需加载能直接减小每个热更新包的体积。属于独立优化，不阻塞本方案。
4. **是否做文件级增量**（只下载变化的文件，而非整个 `out/`）。当前整包 4~5 MB 已经够小，建议第一版不做；若将来 renderer 体积增长，可在 manifest 里加一层文件哈希表，客户端按需下载差异文件。
5. **channel 机制**（stable / beta）在 manifest 里预留了字段，但第一版不实现。
6. ~~**多实例并发更新**~~ **✅ Phase 3 已覆盖**，三层叠加：进程内 `checking` 标志挡住重入（定时器与手动检查撞车是最可能的情况）；跨进程有 single instance lock；而即便前两层都失效，安装本身是 `staging/` 解压 + `rename` 进 `versions/`，同分区 rename 原子，两个进程同时装同一版本的结果是其中一个完整胜出，**不会留下半个版本**。真正未验证的只剩"锁获取失败前那个瞬间"，而那个窗口里第二个进程还没走到更新逻辑。
7. ~~**Cloudflare 侧尚不存在任何基础设施**~~ **✅ 2026-08-07 全部完成**：wrangler 4.119.0、bucket `catmax-updates`、自定义域 `hot.toolpie.dev`、发布 token 均已就位并经公网验证（§9.5）。**唯一遗留的是 token 的权限范围**——它是 account 级 R2 而非 bucket-scoped，触发重建的条件写在 §9.5 的告警里：**一旦在这个账号下为别的项目新建任何 R2 bucket，必须先重建 token 再部署**。本机仍未装 `gh`，mac 完整包若要在本地手工发 Release 需先装它。
8. **Windows 何时恢复分发**尚未决定（§9.2）。需要注意的是，第一期只做 mac 并不会让 Windows 变难做——热更新的客户端代码本身是跨平台的，恢复 Windows 时要补的是**完整包通道**（Actions + `publish` 段 + NSIS 产物），而不是重写热更新。唯一要留心的是 §4.2：electron-builder 26 起 Windows 强制开启 asar integrity fuse，而路线 C 不碰 asar，因此这条约束对本方案无影响——这也正是当初排除路线 B 的理由。

---

## 12. 参考

- [electron-builder Auto Update](https://www.electron.build/docs/features/auto-update/)
- [Electron ASAR Integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity) · [Electron Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)
- [electron-updater `MacUpdater.ts`](https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/src/MacUpdater.ts)
- [electron-builder#7356](https://github.com/electron-userland/electron-builder/issues/7356)（macOS 未签名无法自动更新）
- [CVE-2025-55305](https://www.miggo.io/vulnerability-database/cve/CVE-2025-55305)（ASAR Integrity 绕过）
- CodePush 已于 2025-03-31 随 App Center 下线，仓库 2025-05-20 归档；其"OTA 只更新 JS、native 变更必须走商店"的分层原则仍是本方案 §3.4 的直接来源
