/**
 * Hot Update: R2 旧包清理的选择逻辑（设计文档 §6.6）。
 *
 * 这一层的失败是**不可逆且全量的**：删掉 manifest 当前指向的包，所有客户端的
 * 下载立刻变成 404；删得过狠则服务端失去把 manifest 改回旧版本做紧急下架的能力。
 * 而它的删除分支只在版本数超过 KEEP_RECENT 时才会执行——真实发布跑了很多次也
 * 不会碰到，等碰到时已经发出去了。所以这里全部是构造出来的越界场景。
 */
import { describe, expect, it } from 'vitest'

import { KEEP_MIN, KEEP_RECENT, remoteVersionsToPrune } from '../../scripts/hot-update-config.mjs'

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

describe('remoteVersionsToPrune', () => {
  it('版本数未超过保留数时不删任何东西', () => {
    expect(remoteVersionsToPrune([1], 1)).toEqual([])
    expect(remoteVersionsToPrune(range(KEEP_RECENT), KEEP_RECENT)).toEqual([])
  })

  it('超出后从最旧的开始删，保留数恰好是 KEEP_RECENT', () => {
    const history = range(KEEP_RECENT + 3)
    const current = KEEP_RECENT + 3
    const deleted = remoteVersionsToPrune(history, current)

    expect(deleted).toEqual([3, 2, 1])
    expect(history.length - deleted.length).toBe(KEEP_RECENT)
  })

  it('永不删除 manifest 当前指向的版本', () => {
    // current 故意选一个很旧的版本——服务端下架后 manifest 会指回旧版本，
    // 此时那个旧包绝对不能被"它很旧"这条规则误删。
    const history = range(30)
    expect(remoteVersionsToPrune(history, 2)).not.toContain(2)
    expect(remoteVersionsToPrune(history, 1)).not.toContain(1)
  })

  it('current 不在 history 里也不会误删', () => {
    const deleted = remoteVersionsToPrune(range(20), 99)
    expect(deleted).not.toContain(99)
    expect(deleted.length).toBe(20 - (KEEP_RECENT - 1))
  })

  it('history 有重复项时不会重复删同一个版本', () => {
    const history = [...range(20), 1, 1, 2]
    const deleted = remoteVersionsToPrune(history, 20)
    expect(new Set(deleted).size).toBe(deleted.length)
  })

  it('乱序的 history 也按版本号新旧决定去留', () => {
    const shuffled = [7, 1, 12, 3, 9, 2, 11, 5, 4, 10, 6, 8]
    const deleted = remoteVersionsToPrune(shuffled, 12)
    expect(deleted).toEqual([2, 1])
  })

  it('保留数永不低于 KEEP_MIN', () => {
    const kept = range(50).length - remoteVersionsToPrune(range(50), 50).length
    expect(kept).toBeGreaterThanOrEqual(KEEP_MIN)
  })
})
