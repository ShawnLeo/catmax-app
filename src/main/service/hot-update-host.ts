/**
 * Hot Update: 读取 bootstrap 注入的宿主能力（设计文档 §5.3、§8.4）。
 *
 * **本文件是业务代码接触验签的唯一通道，且它只读不实现。** 验签逻辑与公钥都在
 * `src/bootstrap/` 里、打在 asar 内、永不参与热更新。业务代码一旦静态 import 它们，
 * vite 会把公钥内联进 `out/main/index.js`——那正是热更新替换的对象，等于让公钥
 * 随包下发。`release-hot.mjs` 的内容级断言会直接拒绝这种包，所以这条边界不是
 * 建议而是硬约束。
 *
 * 注入发生在 bootstrap 加载业务入口之前，因此 main 里任何时候读都已就绪。
 * 唯一的例外是 `electron-vite dev`：它直接跑 `out/main/index.js`，bootstrap 根本
 * 没参与，此时 `hotUpdateHost()` 返回 null，整个更新功能静默关闭——开发时不该
 * 有热更新，这正是想要的行为。
 */

/** manifest 里 `latest` 的形状。字段含义见设计文档 §6.3。 */
export interface HotUpdateManifestEntry {
  hotVersion: number
  baseVersion: string
  runtimeId: string
  url: string
  size: number
  sha256: string
  signature: string
  mandatory?: boolean
  releaseNotes?: string
  releasedAt?: string
}

export interface HotUpdateManifest {
  schema: number
  channel?: string
  latest: HotUpdateManifestEntry
  /** 发布侧账本，客户端不使用（§6.6） */
  history?: number[]
}

export type HotUpdateCheckResult = { ok: true } | { ok: false; reason: string; poisoned: boolean }

/**
 * 本文件要求的最低注入接口版本。
 *
 * 用到 bootstrap 新增的注入能力时，**必须**同时提高这里和 bootstrap 里的
 * `apiVersion`。不提就等于让新 main 代码在老 baseline 上调一个不存在的方法：
 * TypeError → 连续两次启动失败 → 回滚，且每次收到新版本都重演一遍，用户被
 * 永久钉在旧版本上。
 *
 * 提高它的代价是老 baseline 从此收不到热更新，只能靠完整安装包救回来——
 * 所以宁可给新能力设计一个可选的降级路径，也不要轻易递增。
 */
const REQUIRED_API_VERSION = 1

export interface HotUpdateHost {
  apiVersion: number
  host: {
    appVersion: string
    runtimeId: string
    /** 本次实际运行的热更新版本，0 = asar 内置 */
    activeHotVersion: number
    /** 已下载待生效的版本，0 = 无 */
    stagedHotVersion: number
  }
  paths: {
    root: string
    stateFile: string
    versionsDir: string
    stagingDir: string
    logFile: string
  }
  /** 已绑定公钥的校验入口——业务代码问"能不能装"，拿不到公钥本身 */
  check: (
    manifest: HotUpdateManifestEntry,
    actualSha256: string,
    currentHotVersion: number,
  ) => HotUpdateCheckResult
  readState: () => { active?: number; confirmed?: number; staged?: number } | null
  stage: (hotVersion: number) => void
  touchLastCheck: () => void
  log: (line: string) => void
}

/**
 * 取宿主能力；未经 bootstrap 启动时返回 null（dev 模式）。
 *
 * 不缓存结果：dev 与打包两种形态在同一次进程里不会切换，缓存省不下什么，
 * 而每次读 globalThis 让"注入失败"表现为功能关闭而不是拿到一个陈旧的空对象。
 */
export function hotUpdateHost(): HotUpdateHost | null {
  const injected = (globalThis as { __catmaxHotUpdate?: HotUpdateHost }).__catmaxHotUpdate
  if (!injected) return null

  // 老 baseline + 新热更新代码的组合：关闭功能，绝不带着缺失的方法往下跑。
  // 关闭是安全的降级——用户停在当前版本照常使用，只是收不到新更新；
  // 崩溃则会触发回滚并把他们锁死在旧版本。
  if ((injected.apiVersion ?? 0) < REQUIRED_API_VERSION) return null

  return injected
}
