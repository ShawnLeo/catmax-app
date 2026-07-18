/**
 * 子进程 spawn 封装。
 *
 * 目的：把 spawn 这件事抽象成可注入接口，
 * 让 CodexAdapter 测试时可以注入 mock，不用真的 spawn codex。
 */
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'

import { logger } from '@main/service/logger'

const log = logger.domain('spawner')

export interface SpawnOptions {
  command: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface SpawnedProcess {
  child: ChildProcess
  /** 写入子进程 stdin */
  write(data: string): void
  /** 关闭 stdin（向子进程发 EOF） */
  endInput(): void
  /** kill 子进程 */
  kill(signal?: NodeJS.Signals): void
  /** pid */
  readonly pid: number | undefined
}

export interface ProcessSpawner {
  spawn(opts: SpawnOptions): SpawnedProcess
}

/** 默认实现：真的 spawn 一个子进程 */
export class RealProcessSpawner implements ProcessSpawner {
  spawn(opts: SpawnOptions): SpawnedProcess {
    log.info('spawning', opts.command, opts.args.join(' '))
    const child = nodeSpawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    child.on('error', (err) => {
      log.error('spawn error:', err)
    })

    return {
      child,
      write: (data) => child.stdin?.write(data),
      endInput: () => child.stdin?.end(),
      kill: (signal) => child.kill(signal),
      pid: child.pid,
    }
  }
}
