/**
 * pty domain IPC 契约。
 * 函数签名即契约——main 实现，renderer 通过 window.api 调用。
 *
 * 这些函数本体在 shared 里只声明类型映射（PtyHandlers），
 * 真实实现在 main/ipc/domains/pty/handlers.ts。
 */

export interface TerminalHandle {
  id: string
  pid: number
  initialCols: number
  initialRows: number
}

export type PtyHandlers = {
  'pty.create': (args: { cwd: string; cols?: number; rows?: number }) => Promise<TerminalHandle>
  'pty.write': (args: { id: string; data: string }) => Promise<void>
  'pty.resize': (args: { id: string; cols: number; rows: number }) => Promise<void>
  'pty.kill': (args: { id: string }) => Promise<void>
}

/** 推送事件 payload */
export interface PtyPushEvents {
  'pty:data': { id: string; data: string }
  'pty:exit': { id: string; exitCode: number }
}
