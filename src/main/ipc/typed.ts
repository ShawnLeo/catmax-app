import { ipcMain, ipcRenderer, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

/**
 * 类型化 IPC（Heckmann 模式）。
 *
 * 设计：
 * - 所有 handler 函数签名作为契约（在 shared/ipc/*.ts 定义）
 * - 主进程用 handleRendererRequest 注册
 * - 渲染层用 requestMain 调用，类型自动从 handler 派生
 * - 改 handler 签名 → renderer 编译报错 → 契约不漂移
 */

type AnyFn = (...args: any[]) => any

/** handler 映射（key = channel name，value = 函数签名） */
export type HandlerMap = Record<string, AnyFn>

/** 推送事件映射（key = channel name，value = payload） */
export type PushEventMap = Record<string, unknown>

/**
 * 主进程侧：注册 handler 的类型化包装。
 *
 * 用法：
 *   handleRendererRequest('workspace.list', listWorkspaces)
 *   handleRendererRequest('workspace.add', addWorkspace)
 */
export function handleRendererRequest<H extends HandlerMap, K extends keyof H & string>(
  channel: K,
  handler: (...args: Parameters<H[K]>) => ReturnType<H[K]> | Promise<ReturnType<H[K]>>,
): void {
  if (ipcMain.eventNames().includes(channel)) {
    throw new Error(`IPC handler "${channel}" already registered`)
  }
  const wrapped = (_event: IpcMainInvokeEvent, ...args: unknown[]) =>
    handler(...(args as Parameters<H[K]>))
  ipcMain.handle(channel, wrapped)
}

/**
 * 主进程侧：向渲染层推送事件。
 */
export function pushToRenderer<P extends PushEventMap, K extends keyof P & string>(
  win: BrowserWindow,
  channel: K,
  payload: P[K],
): void {
  if (!win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

/**
 * 渲染层侧：调用主进程 handler。
 * 这个函数实际在 preload 中使用（preload 能 import electron）。
 */
export function requestMain<H extends HandlerMap, K extends keyof H & string>(
  channel: K,
): (...args: Parameters<H[K]>) => Promise<ReturnType<H[K]>> {
  return (...args: Parameters<H[K]>) =>
    ipcRenderer.invoke(channel, ...args) as Promise<ReturnType<H[K]>>
}

/**
 * 渲染层侧：订阅主进程推送事件。返回取消订阅函数。
 */
export function onMainEvent<P extends PushEventMap, K extends keyof P & string>(
  channel: K,
  callback: (payload: P[K]) => void,
): () => void {
  const listener = (_event: unknown, payload: P[K]) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener as never)
}
