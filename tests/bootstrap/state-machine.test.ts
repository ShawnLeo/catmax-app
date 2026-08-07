/**
 * Hot Update: 启动决策状态机的单测。
 *
 * 这是整个热更新方案里最不能出错的一环（设计文档 §5.4）：写错的后果不是
 * "功能不好用"，而是一个坏包让所有用户的 app 永久打不开，且恢复逻辑本身
 * 也在坏掉的那份代码里。所以这里穷举各条分支，而不只测 happy path。
 */
import { describe, expect, it } from 'vitest'

import {
  BUILTIN,
  confirmBoot,
  createInitialState,
  decideBoot,
  MAX_BOOT_ATTEMPTS,
  versionsToPrune,
  type HotUpdateState,
} from '../../src/bootstrap/state-machine.mjs'

const APP_VERSION = '0.1.0'
const RUNTIME_ID = 'abc123def456'

/** 默认所有版本目录都存在；个别用例再收窄。 */
function env(overrides: { hasVersion?: (n: number) => boolean } = {}) {
  return {
    appVersion: APP_VERSION,
    runtimeId: RUNTIME_ID,
    hasVersion: overrides.hasVersion ?? (() => true),
  }
}

function state(patch: Partial<HotUpdateState> = {}): HotUpdateState {
  return { ...createInitialState(APP_VERSION, RUNTIME_ID), ...patch }
}

describe('decideBoot — 守门', () => {
  it('没有 state.json 时走内置版本', () => {
    const d = decideBoot(null, env())
    expect(d.active).toBe(BUILTIN)
    expect(d.resetAll).toBe(false)
  })

  it('baseVersion 与宿主不符时清空全部热更新', () => {
    const d = decideBoot(state({ baseVersion: '0.0.9', active: 3, confirmed: 3 }), env())
    expect(d.active).toBe(BUILTIN)
    expect(d.resetAll).toBe(true)
    expect(d.nextState.baseVersion).toBe(APP_VERSION)
  })

  it('runtimeId 与宿主不符时清空全部热更新', () => {
    const d = decideBoot(state({ runtimeId: 'stale0000000', active: 3 }), env())
    expect(d.active).toBe(BUILTIN)
    expect(d.resetAll).toBe(true)
  })
})

describe('decideBoot — staged 提升', () => {
  it('staged 在下次启动时成为 active，并重置计数', () => {
    const d = decideBoot(state({ active: 2, confirmed: 2, staged: 3, bootAttempts: 1 }), env())
    expect(d.active).toBe(3)
    expect(d.nextState.staged).toBeNull()
    // 提升后本次启动自己算一次尝试
    expect(d.nextState.bootAttempts).toBe(1)
  })

  it('staged 目录不存在时不提升，并清掉这个悬空引用', () => {
    const d = decideBoot(
      state({ active: 2, confirmed: 2, staged: 9 }),
      env({ hasVersion: (n) => n !== 9 }),
    )
    expect(d.active).toBe(2)
    expect(d.nextState.staged).toBeNull()
  })
})

describe('decideBoot — 坏包回滚（核心）', () => {
  it('计数未达阈值时继续尝试当前版本', () => {
    const d = decideBoot(state({ active: 4, confirmed: 3, bootAttempts: 1 }), env())
    expect(d.active).toBe(4)
    expect(d.nextState.bootAttempts).toBe(2)
    expect(d.discard).toEqual([])
  })

  it('达到阈值时回滚到 confirmed 并删除坏版本', () => {
    const d = decideBoot(state({ active: 4, confirmed: 3, bootAttempts: MAX_BOOT_ATTEMPTS }), env())
    expect(d.active).toBe(3)
    expect(d.discard).toEqual([4])
    expect(d.nextState.confirmed).toBe(3)
  })

  it('confirmed 自己也连续失败时退回内置，不无限循环', () => {
    const d = decideBoot(state({ active: 3, confirmed: 3, bootAttempts: MAX_BOOT_ATTEMPTS }), env())
    expect(d.active).toBe(BUILTIN)
    expect(d.nextState.confirmed).toBe(BUILTIN)
    expect(d.discard).toEqual([3])
  })

  it('回滚目标不存在时继续退到内置', () => {
    const d = decideBoot(
      state({ active: 4, confirmed: 3, bootAttempts: MAX_BOOT_ATTEMPTS }),
      env({ hasVersion: (n) => n !== 3 && n !== 4 }),
    )
    expect(d.active).toBe(BUILTIN)
  })

  it('内置版本不参与计数——它跑不起来时热更新也救不了', () => {
    const d = decideBoot(state({ active: BUILTIN, bootAttempts: 0 }), env())
    expect(d.nextState.bootAttempts).toBe(0)
  })

  it('active 目录被手动删除时落回 confirmed', () => {
    const d = decideBoot(state({ active: 5, confirmed: 4 }), env({ hasVersion: (n) => n !== 5 }))
    expect(d.active).toBe(4)
  })

  it('坏包连续失败的完整轨迹：两次启动后自动回滚', () => {
    let s = state({ active: 4, confirmed: 3, bootAttempts: 0 })

    // 第一次启动：加载 h4，崩了（没走到 confirm）
    let d = decideBoot(s, env())
    expect(d.active).toBe(4)
    s = d.nextState

    // 第二次启动：仍尝试 h4（阈值取 2，允许一次偶发失败）
    d = decideBoot(s, env())
    expect(d.active).toBe(4)
    s = d.nextState

    // 第三次启动：判定为坏包，回滚
    d = decideBoot(s, env())
    expect(d.active).toBe(3)
    expect(d.discard).toEqual([4])
  })
})

describe('confirmBoot', () => {
  it('把 active 记为 confirmed 并清零计数', () => {
    const next = confirmBoot(state({ active: 5, confirmed: 3, bootAttempts: 1 }))
    expect(next.confirmed).toBe(5)
    expect(next.bootAttempts).toBe(0)
  })
})

describe('versionsToPrune', () => {
  it('保护 active / confirmed / staged，并额外保留最近 1 个', () => {
    const s = state({ active: 5, confirmed: 4, staged: 6 })
    // 4/5/6 受保护，剩下 [3,2,1] 里保留最近的 3，删 2 和 1（返回值按版本号降序）
    expect(versionsToPrune(s, [1, 2, 3, 4, 5, 6])).toEqual([2, 1])
  })

  it('confirmed 永不被清理', () => {
    const s = state({ active: 9, confirmed: 1, staged: null })
    expect(versionsToPrune(s, [1, 2, 3, 9])).not.toContain(1)
  })

  it('没有可清理的版本时返回空', () => {
    const s = state({ active: 2, confirmed: 1, staged: null })
    expect(versionsToPrune(s, [1, 2])).toEqual([])
  })
})
