/**
 * Hot Update: 启动决策状态机（**纯函数，无副作用**）。
 *
 * 单独成文件是为了能被单测覆盖——回滚是整个热更新方案里最不能出错的部分
 * （设计文档 §5.4）：它一旦写错，一个坏包会让所有用户的 app 永久打不开，
 * 而恢复逻辑本身也在坏掉的那份代码里。所以这里不碰 fs、不碰 electron，
 * 全部 I/O 留给 index.mjs，逻辑本身可以用假数据穷举测试。
 *
 * 对应设计文档 §5.2（state.json）、§5.4（启动确认与自动回滚）。
 */

/**
 * 连续启动尝试到几次判定为坏包。
 *
 * 取 2 而不是 1：允许一次偶发失败（用户在启动瞬间强制关机、系统休眠打断）
 * 不被误判成坏包。代价是坏包会多崩一次，这个代价可以接受。
 */
export const MAX_BOOT_ATTEMPTS = 2

/** `active = 0` 表示用 asar 内置版本，它永远存在，是最后的退路。 */
export const BUILTIN = 0

export function createInitialState(appVersion, runtimeId) {
  return {
    baseVersion: appVersion,
    runtimeId,
    active: BUILTIN,
    confirmed: BUILTIN,
    staged: null,
    bootAttempts: 0,
    lastCheckAt: 0,
  }
}

/**
 * 决定这次启动加载哪个版本。
 *
 * @param {object|null} state 当前 state.json，无文件时传 null
 * @param {object} env
 * @param {string} env.appVersion  宿主 app.getVersion()
 * @param {string} env.runtimeId   宿主实际的 native 环境指纹
 * @param {(n: number) => boolean} env.hasVersion  versions/h<n>/ 是否存在且完整
 * @returns {{active: number, nextState: object, discard: number[], reason: string, resetAll: boolean}}
 *   discard  —— 应当删除的版本号（坏包）
 *   resetAll —— 应当清空整个 versions/ 目录
 */
export function decideBoot(state, env) {
  const fresh = createInitialState(env.appVersion, env.runtimeId)

  if (!state) {
    return { active: BUILTIN, nextState: fresh, discard: [], reason: '无 state.json', resetAll: false }
  }

  // §7.2 baseVersion 守门：用户装了新的完整安装包，旧热更新全部作废。
  // 没有这道门，用户升级后会被旧的热更新代码覆盖，出现"装了新版却还是老界面"。
  if (state.baseVersion !== env.appVersion) {
    return {
      active: BUILTIN,
      nextState: fresh,
      discard: [],
      reason: `baseVersion ${state.baseVersion} ≠ 宿主 ${env.appVersion}`,
      resetAll: true,
    }
  }

  // §7.3 runtimeId 守门：native 环境变了（Electron/better-sqlite3/node-pty 升级），
  // 旧热更新的 JS 可能调用不存在的 native API，加载即崩。
  if (state.runtimeId !== env.runtimeId) {
    return {
      active: BUILTIN,
      nextState: fresh,
      discard: [],
      reason: `runtimeId ${state.runtimeId} ≠ 宿主 ${env.runtimeId}`,
      resetAll: true,
    }
  }

  let active = Number(state.active) || BUILTIN
  let confirmed = Number(state.confirmed) || BUILTIN
  let staged = state.staged == null ? null : Number(state.staged)
  let bootAttempts = Number(state.bootAttempts) || 0
  const discard = []
  let reason = ''

  // staged → active 的提升。下载完成的包在这次启动才生效（§5.6）。
  // 计数必须归零：新版本是全新的赌注，不该继承上一个版本的失败次数。
  if (staged != null && staged !== active) {
    if (env.hasVersion(staged)) {
      active = staged
      bootAttempts = 0
      reason = `启用已下载的 h${staged}`
    }
    staged = null
  }

  // 坏包判定必须在 ++ 之前：进到这里说明前几次启动都没能走到"确认"那一步。
  if (active !== BUILTIN && bootAttempts >= MAX_BOOT_ATTEMPTS) {
    discard.push(active)
    if (active === confirmed) {
      // confirmed 自己也起不来——它曾经被确认过，现在却连续失败，
      // 多半是宿主环境变了。再退回它自己只会无限循环，直接落到 asar 内置。
      reason = `h${active}（已确认版本）连续失败 ${bootAttempts} 次，退回内置`
      active = BUILTIN
      confirmed = BUILTIN
    } else {
      reason = `h${active} 连续失败 ${bootAttempts} 次，回滚到 h${confirmed || 0}`
      active = confirmed
    }
    bootAttempts = 0
  }

  // 目录不在（手动删除、安装中断、上一步刚被判定为坏包并丢弃）
  if (active !== BUILTIN && !env.hasVersion(active)) {
    reason = `h${active} 目录不存在`
    active = confirmed
  }
  if (active !== BUILTIN && !env.hasVersion(active)) {
    reason = `${reason}，且 confirmed h${confirmed} 也不存在`
    active = BUILTIN
    confirmed = BUILTIN
  }

  // 只有真正要加载热更新版本时才计数。内置版本不需要保护——
  // 它跑不起来的话，热更新机制也救不了。
  if (active !== BUILTIN) bootAttempts += 1

  return {
    active,
    nextState: { ...state, active, confirmed, staged, bootAttempts },
    discard,
    reason: reason || (active === BUILTIN ? '内置版本' : `加载 h${active}`),
    resetAll: false,
  }
}

/**
 * 启动被确认成功后的状态推进（§5.4 的 10 秒定时器到点时调用）。
 *
 * 把当前 active 记为 confirmed —— 它就是将来出问题时的回滚落脚点。
 */
export function confirmBoot(state) {
  return { ...state, confirmed: state.active, bootAttempts: 0 }
}

/**
 * 计算可以安全删除的版本目录（§5.9）。
 *
 * `confirmed` 永不删除：它是回滚的最后落脚点，删掉等于把回滚降级成
 * "退回 asar 内置版本"，用户会损失中间所有已验证过的更新。
 */
export function versionsToPrune(state, existing, keepRecent = 1) {
  const protectedSet = new Set(
    [state.active, state.confirmed, state.staged].filter((n) => n != null && n !== BUILTIN)
  )
  const prunable = existing.filter((n) => !protectedSet.has(n)).sort((a, b) => b - a)
  return prunable.slice(keepRecent)
}
