/**
 * codex 侧的技能开关投影。
 *
 * 钉住两件实测出来的事：
 * 1. 方法名是 `skills/config/write`，参数用 **name** 选择器；
 * 2. **不能**改用 `path` 选择器而不加测试——实测传技能**目录**时 codex 照样回
 *    `{"effectiveEnabled": false}`，但根本没生效；只有传 `skills/list` 返回的
 *    SKILL.md 全路径才算数。这种会骗人的成功响应正是要防的东西。
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { CodexAdapter } from '@main/backend/codex/adapter'
import type { ProcessSpawner, SpawnedProcess } from '@main/backend/process-spawner'
import { describe, expect, test, vi } from 'vitest'

interface Captured {
  method: string
  params: Record<string, unknown>
}

interface Harness {
  spawner: ProcessSpawner
  captured: Captured[]
  /** 从"codex 那边"往 stdout 塞一行——用来伪造 notification。 */
  emit: (obj: unknown) => void
  /** spawn 被调了几次——用来钉住"刷新不该把进程拉起来"。 */
  spawnCount: () => number
}

function createSpawner(): Harness {
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  const captured: Captured[] = []
  let spawns = 0

  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  Object.assign(child, { stdout, stdin, pid: 4343, kill: vi.fn() })

  const push = (obj: unknown): void => {
    stdout.write(`${JSON.stringify(obj)}\n`)
  }

  stdin.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      const msg = JSON.parse(line) as { id?: number; method?: string; params?: unknown }
      if (msg.method === 'initialize') {
        push({ id: msg.id, result: { ok: true } })
        continue
      }
      if (msg.id === undefined) continue
      // initialize 之后 adapter 会顺手拉一次模型列表，跟这个测试无关，别混进来。
      if (msg.method === 'model/list') {
        push({
          id: msg.id,
          result: { data: [{ id: 'gpt-5-codex', displayName: 'g', isDefault: true }] },
        })
        continue
      }
      captured.push({ method: msg.method!, params: (msg.params ?? {}) as Record<string, unknown> })
      if (msg.method === 'skills/config/write') {
        push({ id: msg.id, result: { effectiveEnabled: false } })
      } else {
        push({ id: msg.id, result: {} })
      }
    }
  })

  const spawner: ProcessSpawner = {
    spawn(): SpawnedProcess {
      spawns += 1
      return {
        child: child as unknown as SpawnedProcess['child'],
        write: (data) => stdin.write(data),
        endInput: () => stdin.end(),
        kill: () => {},
        pid: 4343,
      }
    },
  }
  return { spawner, captured, emit: push, spawnCount: () => spawns }
}

describe('codex 技能开关', () => {
  test('关技能发 skills/config/write，用 name 选择器', async () => {
    const { spawner, captured } = createSpawner()
    const adapter = new CodexAdapter({ spawner })

    await adapter.setSkillEnabled('web-perf', false)

    expect(captured).toEqual([
      { method: 'skills/config/write', params: { name: 'web-perf', enabled: false } },
    ])
    // 用 name 而不是 path，是因为 claude 那边只能按名字关（skillOverrides 没有路径
    // 选择器）。两边都按名字，catmax 才不会承诺一个它做不到的语义。
    expect(captured[0]!.params).not.toHaveProperty('path')
  })

  test('开回来同样走这个 RPC——codex 会把 config.toml 里那段整个删掉', async () => {
    const { spawner, captured } = createSpawner()
    const adapter = new CodexAdapter({ spawner })

    await adapter.setSkillEnabled('web-perf', true)

    expect(captured).toEqual([
      { method: 'skills/config/write', params: { name: 'web-perf', enabled: true } },
    ])
  })
})

/**
 * codex **缓存**技能列表且**不 watch 文件系统**（实测：往扫描根里新建技能目录后，
 * 默认的 skills/list 仍然看不到它，等 6 秒也没有任何通知，只有 forceReload:true
 * 那一次才出现）。所以 catmax 建完软链必须主动叫它重扫，否则界面显示成功、
 * 跑着的 codex 却还拿着旧缓存。
 */
describe('codex 技能缓存刷新', () => {
  test('refreshSkills 发 skills/list { forceReload: true }', async () => {
    const { spawner, captured } = createSpawner()
    const adapter = new CodexAdapter({ spawner })

    // 先用一次别的调用把进程和握手带起来
    await adapter.setSkillEnabled('web-perf', false)
    captured.length = 0

    await adapter.refreshSkills()

    expect(captured).toEqual([{ method: 'skills/list', params: { forceReload: true } }])
  })

  test('进程没起来时静默返回，不为了刷新而 spawn', async () => {
    const { spawner, captured, spawnCount } = createSpawner()
    const adapter = new CodexAdapter({ spawner })

    await adapter.refreshSkills()

    // 冷启动本来就会扫最新的，为一次目录变更把 app-server 拉起来是纯浪费，
    // 还会把"建软链"这个操作拖成几秒。
    expect(spawnCount()).toBe(0)
    expect(captured).toEqual([])
  })
})

describe('codex skills/changed 通知', () => {
  test('没有 turn 在跑时也能收到——技能变更几乎总是发生在这种时候', async () => {
    const { spawner, emit } = createSpawner()
    const onSkillsChanged = vi.fn()
    const adapter = new CodexAdapter({ spawner, onSkillsChanged })

    await adapter.setSkillEnabled('web-perf', false)
    expect(onSkillsChanged).not.toHaveBeenCalled()

    emit({ jsonrpc: '2.0', method: 'skills/changed', params: {} })
    await new Promise((r) => setTimeout(r, 10))

    // 关键：handleNotification 里这一支必须排在 currentSink 的 early return 之前，
    // 否则永远收不到（没有 turn 在跑就没有 sink）。
    expect(onSkillsChanged).toHaveBeenCalledTimes(1)
  })
})
