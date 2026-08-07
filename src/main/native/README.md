# `src/main/native/` — 无法 bundle 的依赖的加载 shim

**这个目录的存在只有一个原因：热更新（Hot Update）。**

主进程产物 `out/main/index.js` 会被侧载到 `userData/hot-updates/versions/<n>/` 下执行。
ESM 的 bare specifier（`import 'better-sqlite3'`）是按 **importer 所在目录**向上查找
`node_modules` 解析的 —— 侧载位置那棵目录树里一个 `node_modules` 都没有，一路找到
用户家目录仍然没有，于是 `ERR_MODULE_NOT_FOUND`，应用直接起不来。

Phase 0 PoC 实测确认了三件事（见设计文档 §0.1）：

1. **符号链接指向 asar 内的 `node_modules` 无效** —— ESM resolver 在 C++ 层实现，
   不经过 Electron 给 `fs` 打的 asar patch。
2. **CJS 的 `createRequire` 可以穿透 asar** —— 包括 `app.asar.unpacked` 里的
   `.node` 二进制，`better-sqlite3` 和 `node-pty` 都实测加载成功。
3. `electron` 本身不受影响 —— 它由 Electron 运行时注入，不走 `node_modules` 解析。

所以策略是：**纯 JS 依赖一律 bundle 进产物**（见 `electron.vite.config.ts` 的
`externalizeDepsPlugin({ exclude: [...] })`），只有真正无法 bundle 的留在这里，
由 shim 在运行时用 `createRequire(app.getAppPath())` 从 asar 内取。

## 什么情况下需要往这里加文件

只有当一个依赖**无法被 bundle** 时：

- 含 `.node` 原生二进制（`better-sqlite3`、`node-pty`）
- 运行时要 spawn 自带的平台二进制、或有 bundler 静态分析不了的动态 require
  （`@anthropic-ai/claude-agent-sdk`）

其余情况一律加进 `electron.vite.config.ts` 的 `exclude` 列表让它被 bundle。
**bundle 是默认选项，shim 是例外**——每加一个 shim，热更新包就多一份对 asar 内容的
运行时依赖，也就多一种"宿主和热更新包版本不匹配"的失败可能（这正是 §7.3 `runtimeId`
要挡住的事故）。

## 加一个 shim 的步骤

1. 在本目录建 `<包名>.ts`，用 `nativeRequire` 取真包并**显式**重新导出用到的成员
   （ESM 的 `export *` 无法转发运行时值，必须逐个列）
2. 在 `electron.vite.config.ts` 的 `main.resolve.alias` 里把包名指向该文件
3. 类型继续从真包 `import type`：类型在编译期被擦除，不会进 bundle，也就不会被
   alias 影响
