import { ctx } from '@main/context'
import type { TerminalHandle } from '@shared/ipc/pty'

export const createTerminal = async (args: {
  cwd: string
  cols?: number
  rows?: number
}): Promise<TerminalHandle> => {
  const inst = ctx.ptyManager.create({
    cwd: args.cwd,
    ...(args.cols !== undefined && { cols: args.cols }),
    ...(args.rows !== undefined && { rows: args.rows }),
  })
  return {
    id: inst.id,
    pid: inst.pid,
    initialCols: args.cols ?? 80,
    initialRows: args.rows ?? 24,
  }
}

export const writeTerminal = async (args: { id: string; data: string }): Promise<void> => {
  ctx.ptyManager.write(args.id, args.data)
}

export const resizeTerminal = async (args: {
  id: string
  cols: number
  rows: number
}): Promise<void> => {
  ctx.ptyManager.resize(args.id, args.cols, args.rows)
}

export const killTerminal = async (args: { id: string }): Promise<void> => {
  ctx.ptyManager.kill(args.id)
}
