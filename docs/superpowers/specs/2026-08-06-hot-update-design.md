# Electron 增量热更新（Hot Update）调研与设计

- **状态**：设计待评估，**尚未实现**。§0.3 列出的三条假设必须先做 PoC 验证，验证结果可能推翻 §5 的部分设计。
- **日期**：2026-08-06
- **范围**：让 catmax-app 的业务代码变更（`out/main` + `out/preload` + `out/renderer`）能够不重装、不下载完整安装包地送达用户；以及配套的服务端文件布局、manifest 协议、版本模型、回滚与安全机制
- **不在范围**：Electron 自身升级、native 模块（`better-sqlite3` / `node-pty`）升级、claude 二进制升级——这三类**只能**走完整安装包（§4.3）；Linux 分发；应用内的更新 UI 细节
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

### 0.2 引用官方文档 / 源码，但未在本机复现

- **Squirrel.Mac 要求正式开发者签名**，ad-hoc 不被接受 → electron-updater 在当前未签名的 mac 构建上无法工作。来源：electron-builder 官方 auto-update 文档「macOS application must be signed in order for auto updating to work」，以及 electron-builder#7356、Squirrel.Mac#179。
- **electron-updater 的 macOS 更新走 zip，不走 dmg**：`MacUpdater.ts` 里 `findFile(files, "zip", ["pkg", "dmg"])`，且差分下载依赖缓存的 `update.zip`（首次安装无差分）。当前 `electron-builder.yml` 的 mac target 只有 `dmg`，`latest-mac.yml` 里没有 zip 条目。
- **electron-builder 26 起，Windows 构建强制开启 `EnableEmbeddedAsarIntegrityValidation` + `OnlyLoadAppFromAsar` 且不可关闭**。开启后 Electron 启动时校验 asar 哈希，不匹配即进程终止。
- **ASAR integrity 的平台支持**：macOS 需 Electron ≥16，Windows 需 Electron ≥30；替换 app.asar 会导致哈希不匹配、应用被强制终止。来源：Electron 官方 ASAR Integrity 文档。
- **修改已签名 .app bundle 内任何文件都会让签名失效**。来源：Apple Developer Forums 多个 thread。

### 0.3 必须先做 PoC 才能动工的假设

**这三条如果不成立，§5 的架构要改。评估这份方案时请把它们当作风险项，而不是既定事实。**

1. **Electron 31 的 ESM 主进程能否从 `userData` 动态 `import()` 一个 file:// URL。** 项目是 `"type": "module"`，`out/main/index.js` 是 ESM 产物。bootstrap 需要 `await import(pathToFileURL(...))` 去加载 app bundle 之外的模块。Electron 对主进程 ESM 的加载有自己的限制（例如 `app.whenReady()` 之前的时序、asar 之外路径的处理），需要真跑一次。
   *若不成立的退路*：把 `out/main` 打成单文件 CJS（`electron-vite` 的 main 配置改 `format: 'cjs'`），用 `require()` 加载。
2. **`hardenedRuntime: true` 下，从 app bundle 外加载 JS 是否被系统阻止。** 理论上不会——代码签名和 library validation 管的是 Mach-O 二进制，JS 只是数据；且 `build/entitlements.mac.plist` 已经开了 `disable-library-validation`。但这是整个方案的地基，必须实测。
3. **`win.loadFile()` 指向 `userData` 下的 `index.html` 后，渲染进程的相对资源（`assets/*.js`）能否正常解析，且 preload 能否从 `userData` 加载。** 需要连带确认 CSP 和 `file://` 的行为。
   *若受限的退路*：注册 `app://` 自定义 protocol 映射到当前版本目录，比 `file://` 更可控，也顺带解决 CSP。

另有两条**推断成立、影响较小**、建议顺手验证的：Windows 的 `perMachine: false` 装在 `%LOCALAPPDATA%`，写 userData 不触发 UAC；以及热更新后 `app.getVersion()` 仍返回宿主版本（不随热更新变）。

---

## 1. 结论速览

1. **"增量更新"和"热更新"是两件事，本项目两件都要，但用在不同场景。** 差分下载（blockmap）仍然要重装+重启，只是下载量小；热更新不碰安装包，重启进程即可生效。
2. **选定路线：userData 侧载（CodePush 风格）**，即 app bundle 保持不变，业务代码 `out/` 放到 `userData` 下由 bootstrap 决定加载哪一份。理由不是它最简单（替换 app.asar 更简单），而是它是唯一同时满足下面四条的方案：不破坏 macOS 代码签名、不受 asar integrity fuse 影响（因此可以安全升级 electron-builder 到 26+）、回滚只需改一个 JSON、将来正式签名了也不用改架构。
3. **服务端不需要写应用服务器。** 静态文件托管 + 一个 manifest.json 就是完整的第一版。灰度和统计需要动态接口，但可以后加，且只需要一个 GET。
4. **热更新包只含 `out/` 三个子目录，约 4~5 MB（tar.gz 后）**，相对完整包 168 MB。
5. **对当前这个未签名的 macOS 构建，热更新不是"更好的方案"，而是唯一可行的自动更新路径**——Squirrel.Mac 拒绝 ad-hoc 签名（§0.2），线 A 在 mac 上根本起不来。
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

### 3.4 不是二选一：分层发版

A 和 C 不冲突，服务于不同变更：

| 变更类型 | 走哪条 | 频率 |
|---|---|---|
| 业务代码（`out/main` `out/preload` `out/renderer`） | **热更新**（C） | 每次发版，占 95%+ |
| Electron 升级 / native 模块 / claude SDK / 新增 dependency / bootstrap 自身 | **完整安装包**（A） | 数月一次 |

判断由发布脚本自动做（§7.3、§9），不靠人记。

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
| `bootAttempts` | `active` 连续启动尝试次数，≥2 判定为坏包 |

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

### 5.5 为什么业务代码几乎不用改

实测（§0.1）：

- `src/main/window.ts:35` 的 preload 路径是 `join(__dirname, '../preload')`
- `src/main/window.ts:192` 的 renderer 是 `loadFile(join(__dirname, '../renderer/index.html'))`

当 bootstrap 加载 `versions/h4/main/index.js` 时，`__dirname` 自然是 `versions/h4/main`，于是 preload 和 renderer 自动指向同一版本目录。**只要 `versions/<n>/` 与 `out/` 同构，这两处不需要任何改动。**

需要留意的例外：

- `src/main/window.ts:23` 有一处 `join(__dirname, '../resources/icon.png')` 的**兜底**路径，侧载后会失效。但主路径 `app.getAppPath()` 仍然有效（指向 asar），且 `resources/` 本来就在 `asarUnpack` 里不参与热更新，所以无实际影响。
- 任何将来新增的、用 `__dirname` 去访问 `resources/` 或 native 模块的代码都会踩坑。约定：**`__dirname` 只用于定位 `out/` 内部的产物；访问 bundle 内资源一律用 `app.getAppPath()` / `process.resourcesPath`。**

---

## 6. 服务端

### 6.1 第一版不需要写任何服务端代码

客户端做的三件事——拉 manifest、比版本、下包——都不需要服务端参与决策。一个静态文件托管就是完整的第一版。

需要动态接口的只有三种情况，都可以后加：按用户灰度、更新率统计、紧急下架某个版本。

### 6.2 需要上传的文件

**线 A：完整安装包**（低频）

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

**线 B：热更新包**（高频）

```
out/main/index.js       640 KB
out/preload/index.mjs    16 KB
out/renderer/**          14 MB
                    → 打成 h<N>.tar.gz，约 4~5 MB
```

**绝不能进热更新包**：`node_modules`、`package.json`、`resources/`、bootstrap 自身。

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
  }
}
```

三个字段撑起整个协议的正确性：

- **`baseVersion`**：见 §7.2
- **`runtimeId`**：见 §7.3
- **`signature`**：对 `sha256` 值做的 Ed25519 签名。`sha256` 只防传输损坏，签名才防投毒，两者都要（§8）

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
| 完整安装包 | GitHub Releases | `app-update.yml` 已配好 `provider: github` / `ShawnLeo/catmax-app`，零成本；低频下载，国内慢一点可接受 |
| 热更新包 | **Cloudflare R2** + 自定义域 | 出站流量免费。热更新是高频小包下载，放按流量计费的对象存储会被流量费咬 |

也可以两条线都放 R2，代价是要自己维护 `latest*.yml`（electron-updater 的 `generic` provider 支持）。

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

---

## 9. 发布流程

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

---

## 10. 实施阶段

| Phase | 内容 | 产出 | 依赖 |
|---|---|---|---|
| **0** | PoC 验证 §0.3 的三条假设 | 一份验证记录，确认或推翻架构 | — |
| **1** | 接入 electron-updater 完整包更新（线 A） | Windows 侧可用的自动更新；验证静态托管与发布流程 | — |
| **2** | bootstrap + 状态机 + 回滚，**不带网络** | 手动放版本目录进 `versions/` 即可测试加载与回滚 | Phase 0 |
| **3** | manifest 拉取 + 下载 + 验签 + 安装 | 完整热更新链路 | Phase 2 |
| **4** | 更新 UI（提示、进度、重启按钮）、灰度接口 | — | Phase 3 |

**Phase 2 必须先于 Phase 3。** 回滚机制没有单独验证过就上线热更新，等于把所有用户的 app 押在"发布流程永不出错"上。手动构造一个坏包（比如 `main/index.js` 里第一行就 `throw`）验证能自动回滚，是 Phase 2 的验收标准。

Phase 1 独立于其余阶段，可以并行或先做——它顺带验证了静态托管、签名密钥管理、发布脚本这些 Phase 3 也要用的基础设施。

---

## 11. 未决问题

1. **§0.3 的三条假设未验证**，Phase 0 的结论可能推翻 §5.3 的 ESM loader 设计。
2. **macOS 是否购买开发者签名**尚未决定。买了则线 A 在 mac 上解锁，本方案不受影响（路线 C 不碰 bundle）；不买则热更新是 mac 唯一的自动更新路径，§5.4 的回滚机制的重要性进一步上升。
3. **`out/renderer` 还有 14 MB 可压缩空间**：shiki 把所有语言的高亮规则全量打进去了（`emacs-lisp` 804 KB、`cpp` 697 KB、`wasm` 622 KB、`wolfram` 268 KB…）。改成按需加载能直接减小每个热更新包的体积。属于独立优化，不阻塞本方案。
4. **是否做文件级增量**（只下载变化的文件，而非整个 `out/`）。当前整包 4~5 MB 已经够小，建议第一版不做；若将来 renderer 体积增长，可在 manifest 里加一层文件哈希表，客户端按需下载差异文件。
5. **channel 机制**（stable / beta）在 manifest 里预留了字段，但第一版不实现。
6. **多实例并发更新**：`src/main/index.ts` 已有 single instance lock，理论上不会有两个进程同时写 `versions/`。但用户手动启动第二个副本、锁获取失败前的那个瞬间是否安全，需要确认。

---

## 12. 参考

- [electron-builder Auto Update](https://www.electron.build/docs/features/auto-update/)
- [Electron ASAR Integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity) · [Electron Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)
- [electron-updater `MacUpdater.ts`](https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/src/MacUpdater.ts)
- [electron-builder#7356](https://github.com/electron-userland/electron-builder/issues/7356)（macOS 未签名无法自动更新）
- [CVE-2025-55305](https://www.miggo.io/vulnerability-database/cve/CVE-2025-55305)（ASAR Integrity 绕过）
- CodePush 已于 2025-03-31 随 App Center 下线，仓库 2025-05-20 归档；其"OTA 只更新 JS、native 变更必须走商店"的分层原则仍是本方案 §3.4 的直接来源
