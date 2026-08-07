/**
 * Hot Update: node-pty 的加载 shim。见 ./README.md。
 *
 * 业务代码用的是 `import * as pty from 'node-pty'`，namespace import 拿到的是本模块
 * 全部具名导出组成的 namespace，所以这里只需把实际用到的成员逐个导出即可
 * （ESM 的 `export *` 无法转发 createRequire 拿到的运行时值）。
 * pty.IPty 是纯类型，编译期擦除，不必也无法在这里转发。
 */
import type * as PtyModule from 'node-pty'

import { nativeRequire } from './require'

const pty = nativeRequire('node-pty') as typeof PtyModule

export const spawn = pty.spawn
