/**
 * Hot Update: 从 app bundle（asar）内加载无法 bundle 的依赖。
 *
 * 侧载执行时，本模块的位置在 userData 下，ESM 的 bare specifier 解析会失败；
 * 而 CJS 的 require 走 Electron 给 fs 打过 asar patch 的那条路径，可以正常读到
 * asar 内、乃至 app.asar.unpacked 里的 .node 二进制（Phase 0 实测确认）。
 *
 * 基点必须是 app.getAppPath()——它在两种加载方式下都指向 app bundle：
 * 打包后是 .../Contents/Resources/app.asar，dev 下是项目根。
 * 绝不能用 import.meta.url，那才是会跟着侧载位置漂走的东西。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { app } from 'electron'

// app.getAppPath() 不需要等 app ready，模块顶层调用是安全的。
export const nativeRequire = createRequire(join(app.getAppPath(), 'package.json'))
