/**
 * Hot Update: better-sqlite3 的加载 shim。见 ./README.md。
 *
 * 业务代码里的 `import Database from 'better-sqlite3'` 由 electron.vite.config.ts
 * 的 alias 重定向到这里，运行时再从 asar 内取真包。
 */
import type BetterSqlite3 from 'better-sqlite3'

import { nativeRequire } from './require'

export default nativeRequire('better-sqlite3') as typeof BetterSqlite3
