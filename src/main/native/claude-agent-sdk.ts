/**
 * Hot Update: @anthropic-ai/claude-agent-sdk 的加载 shim。见 ./README.md。
 *
 * 这个包不能 bundle：它在运行时 spawn 自带的平台二进制（约 245 MB，被 asarUnpack
 * 出去），且内部有 bundler 静态分析不了的动态 resolve。
 *
 * 它也不能像另外两个 shim 那样直接 nativeRequire()——**这个包是纯 ESM**
 * （入口是 sdk.mjs），require() 会得到 ERR_REQUIRE_ESM。所以这里分两步：
 * 先用 nativeRequire.resolve() 拿到它在 asar 内的绝对路径（resolve 只查找不加载，
 * 对纯 ESM 包同样有效），再用动态 import() 以 file:// URL 载入。
 *
 * 顶层 await 会让本模块成为异步模块，进而使整条 import 链异步——这是安全的：
 * bootstrap 本来就是 `await import(entry)` 进来的，Electron 主进程的 ESM 入口
 * 支持顶层 await。
 *
 * 只需转发**值**导出——包里大量的 SDKMessage 等类型仍由业务代码直接从真包
 * `import type`，编译期擦除，不经过这里。
 */
import { pathToFileURL } from 'node:url'

import type * as ClaudeSdk from '@anthropic-ai/claude-agent-sdk'

import { nativeRequire } from './require'

const sdkPath = nativeRequire.resolve('@anthropic-ai/claude-agent-sdk')
const sdk = (await import(pathToFileURL(sdkPath).href)) as typeof ClaudeSdk

export const query = sdk.query
export const deleteSession = sdk.deleteSession
export const forkSession = sdk.forkSession
