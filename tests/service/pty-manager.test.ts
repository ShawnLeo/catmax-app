// @vitest-environment node
//
// PtyManager spawns a real shell via node-pty. The default happy-dom environment
// cannot satisfy node-pty's native bindings, so we run under the node environment
// (same lesson as Plan 4a editor-launcher test).
import { tmpdir } from 'node:os'

import { PtyManager } from '@main/service/pty-manager'
import { afterEach, describe, expect, test } from 'vitest'

let manager: PtyManager

afterEach(() => {
  manager?.killAll()
})

describe('PtyManager', () => {
  test('create 返回 handle + 发出初始数据', async () => {
    const dataCalls: Array<{ id: string; data: string }> = []
    manager = new PtyManager({
      onData: (id, data) => dataCalls.push({ id, data }),
      onExit: () => {},
    })

    const handle = manager.create({ cwd: tmpdir() })
    expect(handle.id).toBeTruthy()
    expect(typeof handle.pid).toBe('number')
    expect(manager.has(handle.id)).toBe(true)
    expect(manager.size()).toBe(1)

    // 等终端启动发欢迎信息
    await new Promise((r) => setTimeout(r, 300))
    expect(dataCalls.length).toBeGreaterThan(0)
  })

  test('write 输入命令', async () => {
    const dataCalls: string[] = []
    manager = new PtyManager({
      onData: (_id, data) => dataCalls.push(data),
      onExit: () => {},
    })

    const handle = manager.create({ cwd: tmpdir() })
    await new Promise((r) => setTimeout(r, 200))

    // 输入 echo 命令
    manager.write(handle.id, 'echo hello_test_1234\n')
    await new Promise((r) => setTimeout(r, 300))

    const combined = dataCalls.join('')
    expect(combined).toContain('hello_test_1234')
  })

  test('kill 清理实例', async () => {
    manager = new PtyManager({
      onData: () => {},
      onExit: () => {},
    })

    const handle = manager.create({ cwd: tmpdir() })
    expect(manager.has(handle.id)).toBe(true)

    manager.kill(handle.id)
    expect(manager.has(handle.id)).toBe(false)
  })

  test('exit 自动清理', async () => {
    const exitCalls: string[] = []
    manager = new PtyManager({
      onData: () => {},
      onExit: (id) => exitCalls.push(id),
    })

    const handle = manager.create({ cwd: tmpdir() })
    await new Promise((r) => setTimeout(r, 200))

    // 让 shell 退出
    manager.write(handle.id, 'exit\n')
    await new Promise((r) => setTimeout(r, 500))

    expect(exitCalls).toContain(handle.id)
    expect(manager.has(handle.id)).toBe(false)
  })
})
