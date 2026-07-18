/**
 * 终端进程管理器。
 *
 * - 用 node-pty spawn shell
 * - 每个实例一个唯一 id
 * - 通过事件回调把输出发给调用方（IPC handler 再转给 renderer）
 * - 实例退出时自动清理
 */
import { randomUUID } from 'node:crypto'

import * as pty from 'node-pty'

import { logger } from './logger'

const log = logger.domain('pty-manager')

export interface PtyCreateOptions {
  cwd?: string
  cols?: number
  rows?: number
  shell?: string
}

export interface PtyInstance {
  id: string
  pid: number
  proc: pty.IPty
}

export interface PtyCallbacks {
  onData: (id: string, data: string) => void
  onExit: (id: string, exitCode: number) => void
}

/** 默认 shell（按平台） */
function getDefaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe'
  }
  return process.env.SHELL || '/bin/zsh'
}

export class PtyManager {
  private instances = new Map<string, PtyInstance>()
  private callbacks: PtyCallbacks

  constructor(callbacks: PtyCallbacks) {
    this.callbacks = callbacks
  }

  create(opts: PtyCreateOptions = {}): PtyInstance {
    const id = randomUUID()
    const shell = opts.shell ?? getDefaultShell()
    const cols = opts.cols ?? 80
    const rows = opts.rows ?? 24

    log.info('creating terminal', id, shell)

    const proc = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols,
      rows,
      cwd: opts.cwd ?? process.cwd(),
      env: process.env as Record<string, string>,
    })

    proc.onData((data) => {
      this.callbacks.onData(id, data)
    })
    proc.onExit(({ exitCode }) => {
      log.info('terminal exited', id, exitCode)
      this.callbacks.onExit(id, exitCode)
      this.instances.delete(id)
    })

    const instance: PtyInstance = { id, pid: proc.pid, proc }
    this.instances.set(id, instance)
    return instance
  }

  write(id: string, data: string): void {
    const inst = this.instances.get(id)
    if (!inst) {
      log.warn('write: unknown id', id)
      return
    }
    inst.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const inst = this.instances.get(id)
    if (!inst) return
    try {
      inst.proc.resize(cols, rows)
    } catch (e) {
      log.warn('resize failed:', e)
    }
  }

  kill(id: string): void {
    const inst = this.instances.get(id)
    if (!inst) return
    log.info('killing terminal', id)
    try {
      inst.proc.kill()
    } catch {
      // 已退出
    }
    this.instances.delete(id)
  }

  /** 杀所有（app 退出时） */
  killAll(): void {
    for (const id of this.instances.keys()) {
      this.kill(id)
    }
  }

  has(id: string): boolean {
    return this.instances.has(id)
  }

  size(): number {
    return this.instances.size
  }
}
