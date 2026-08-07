/**
 * Hot Update: bootstrap loader —— 打进 asar，**永不参与热更新**。
 *
 * 这是整个热更新方案里唯一不可被远程替换的代码。将来的验签逻辑和公钥都必须
 * 待在这里：一旦它们可以被热更新包替换，攻击者只要投一个包就能把验签换成空实现，
 * 之后所有防护全部失效。这也是它不经过 vite 构建的原因——vite 会把它和业务代码
 * 打进同一个 out/main/index.js，而那个文件恰恰是要被热更新替换的对象。
 *
 * 职责边界：本文件只做 I/O 和编排，所有决策在 state-machine.mjs 里（纯函数、有单测）。
 *
 * 设计文档：docs/superpowers/specs/2026-08-06-hot-update-design.md §5.3、§5.4、§8.4
 */
import crypto from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { app } from 'electron'

import { UPDATE_PUBLIC_KEY } from './public-key.mjs'
import { checkUpdate } from './signing.mjs'
import { confirmBoot, decideBoot, versionsToPrune } from './state-machine.mjs'
import {
  hotUpdatePaths,
  listVersions,
  readState,
  removeVersion,
  resetAllVersions,
  versionEntry,
  writeState,
} from './state-store.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** asar 内置的业务入口。所有失败路径最终都要能回到这里。 */
const BUILTIN_ENTRY = join(here, '../main/index.js')

/**
 * 启动确认延迟（§5.4）。
 *
 * 太短会把"能启动但几秒后就崩"的包标记为好包；太长则正常用户长时间停留在
 * 未确认状态，期间再次启动会让 bootAttempts 涨到阈值、误判成坏包。
 */
const CONFIRM_DELAY_MS = 10_000

const paths = hotUpdatePaths(app.getPath('userData'))

function log(line) {
  console.log('[hot-update]', line)
  try {
    mkdirSync(paths.root, { recursive: true })
    appendFileSync(paths.logFile, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    // 日志写不进去不能影响启动
  }
}

/**
 * 宿主的 native 环境指纹（§7.3）。
 *
 * 由构建脚本写在 bootstrap 旁边，**不在 out/main 里**——那里会被热更新整个替换掉，
 * 一个能被热更新包自己改写的指纹起不到守门作用。
 */
function hostRuntimeId() {
  try {
    return JSON.parse(readFileSync(join(here, 'runtime-id.json'), 'utf8')).runtimeId ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 决定入口并把状态推进一格。**必须同步完成且绝不抛出**——它运行在
 * app.whenReady() 之前，此时没有任何业务代码可用，抛出等于应用直接打不开。
 */
function resolveEntry() {
  const state = readState(paths)
  const decision = decideBoot(state, {
    appVersion: app.getVersion(),
    runtimeId: hostRuntimeId(),
    hasVersion: (n) => existsSync(versionEntry(paths, n)),
  })

  if (decision.resetAll) {
    resetAllVersions(paths)
    log(`清空全部热更新版本：${decision.reason}`)
  }
  for (const n of decision.discard) {
    removeVersion(paths, n)
    log(`删除坏版本 h${n}`)
  }

  // ⚠️ 顺序是死的：bootAttempts++ 必须在加载业务代码**之前**落盘。
  // 放到之后的话，一个在 import 阶段就崩溃的包永远推不动计数器，
  // 回滚判定永远不触发，应用进入永久崩溃循环。
  writeState(paths, decision.nextState)

  return decision
}

/**
 * 启动确认（§5.4）。窗口加载完成后再稳定运行 10 秒，才把当前版本记为 confirmed。
 *
 * 挂在 bootstrap 而不是业务代码里，是为了让业务代码对热更新完全无感——
 * 它不需要知道自己是从 asar 还是 userData 跑起来的。
 */
function scheduleConfirm(active) {
  if (active === 0) return

  let done = false
  const confirm = () => {
    if (done) return
    done = true
    try {
      const state = readState(paths)
      if (!state || state.active !== active) return
      const next = confirmBoot(state)

      // 确认之后才清理旧版本：确认之前 confirmed 还是上一个版本，此刻删掉它
      // 等于把回滚的落脚点抽走。
      const prune = versionsToPrune(next, listVersions(paths))
      for (const n of prune) {
        removeVersion(paths, n)
        log(`清理旧版本 h${n}`)
      }
      writeState(paths, next)
      log(`✅ h${active} 启动确认通过，已记为 confirmed`)
    } catch (err) {
      log(`启动确认写盘失败（不影响本次运行）：${err?.message ?? err}`)
    }
  }

  app.on('browser-window-created', (_event, win) => {
    win.webContents.once('did-finish-load', () => {
      setTimeout(confirm, CONFIRM_DELAY_MS).unref?.()
    })
  })
}

/**
 * 把验签能力注入给业务代码（§5.3、§8.4）。
 *
 * **业务代码绝不能自己 import 验签逻辑。** `src/main/**` 里任何一处静态 import
 * `signing.mjs` 或 `public-key.mjs`，vite 都会把它内联进 `out/main/index.js`——
 * 而那个文件正是热更新要替换的对象，等于让公钥随热更新包一起下发，验签机制自我瓦解。
 * `release-hot.mjs` 的内容级断言会当场拒绝这种包，所以这不是"最好别做"，是根本发不出去。
 *
 * 从 asar 内的 bootstrap 注入解决了这个矛盾：验签实现与公钥始终来自 asar，
 * 不随热更新变化；业务代码只拿到一个已经绑好公钥的 `check()`，碰不到公钥本身，
 * 也就不可能把它打进包里。
 *
 * 顺带绕开了 Phase 0 实测的另一个坑（§5.10）：Electron 对 asar 的 fs patch
 * 不覆盖 C++ 层的 ESM resolver，业务代码即便想在运行时 `import()` asar 里的
 * `signing.mjs` 也未必成功。而 bootstrap 早已加载过它。
 */
function injectHotUpdateHost(activeVersion) {
  const state = readState(paths)
  globalThis.__catmaxHotUpdate = {
    /**
     * 注入接口的版本。**bootstrap 在 asar 内，热更新替换不了它**，所以业务代码
     * 与 bootstrap 的版本会随时间分叉：一个用户可能 baseline 停在 0.1.0（本文件
     * 的这一版），却已经热更新到很久以后的 main 代码。那份新 main 若直接调用一个
     * 这里还不存在的方法，会 TypeError → 连续两次启动失败 → 回滚，而且每次收到
     * 新版本都重复一遍，用户被永久钉死在旧版本上。
     *
     * 所以业务代码必须先比对这个号，不满足就**关闭热更新功能**而不是崩溃
     * （见 `hot-update-host.ts` 的 REQUIRED_API_VERSION）。递增它等于宣告
     * "老 baseline 收不到新热更新了"，只能靠发完整安装包解决——非必要不要动。
     */
    apiVersion: 1,
    host: {
      appVersion: app.getVersion(),
      runtimeId: hostRuntimeId(),
      activeHotVersion: activeVersion,
      stagedHotVersion: state?.staged ?? 0,
    },
    paths: { ...paths },
    /** 已绑定公钥的校验入口。业务代码只能问"这个更新能不能装"，拿不到公钥。 */
    check: (manifest, actualSha256, currentHotVersion) =>
      checkUpdate(crypto, UPDATE_PUBLIC_KEY, manifest, actualSha256, {
        appVersion: app.getVersion(),
        runtimeId: hostRuntimeId(),
        currentHotVersion,
      }),
    readState: () => readState(paths),
    /**
     * 标记某个版本待生效。**只写 staged，绝不动 active/confirmed**——
     * 那两个字段归启动时的状态机独占，中途改写会让回滚判定读到自相矛盾的状态。
     */
    stage: (hotVersion) => {
      const current = readState(paths) ?? {}
      writeState(paths, { ...current, staged: hotVersion, lastCheckAt: Date.now() })
    },
    touchLastCheck: () => {
      const current = readState(paths) ?? {}
      writeState(paths, { ...current, lastCheckAt: Date.now() })
    },
    log,
  }
}

let decision
try {
  decision = resolveEntry()
} catch (err) {
  // 状态机或文件系统出任何问题，一律降级到内置版本
  decision = { active: 0, reason: `resolveEntry 异常：${err?.message ?? err}` }
  log(decision.reason)
}

const entry = decision.active === 0 ? BUILTIN_ENTRY : versionEntry(paths, decision.active)
log(`启动 ${app.getVersion()} · ${decision.reason} · entry=${entry}`)

try {
  scheduleConfirm(decision.active)
  injectHotUpdateHost(decision.active)
  await import(pathToFileURL(entry).href)
} catch (err) {
  log(`❌ 加载失败：${err?.stack ?? err}`)
  if (entry === BUILTIN_ENTRY) throw err

  // 本次不重试同一个版本——bootAttempts 已经写盘，下次启动会走回滚判定。
  // 这里只是让用户当下还能用上 app。
  log('→ 本次降级到 asar 内置版本')
  // 重新注入：state.active 仍是那个坏版本，但本次实际运行的是内置版本。
  // 不改的话更新检查会以为自己已经在 hN 上，从而跳过一个本该安装的修复版本。
  injectHotUpdateHost(0)
  await import(pathToFileURL(BUILTIN_ENTRY).href)
}
