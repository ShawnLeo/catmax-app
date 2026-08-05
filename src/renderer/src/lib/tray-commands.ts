/**
 * Tray Command Handoff: 接住托盘菜单派过来的命令。
 *
 * 主进程只报"用户点了哪一项"，具体行为仍然复用 commands.ts 里已注册的同 id 命令，
 * 所以托盘菜单和命令面板（⌘K）永远是同一套逻辑，不会各改各的。
 *
 * 两条来路，对应窗口的两种状态：
 * - 窗口本来就活着 → 主进程直接 push（onTrayCommand）；
 * - 窗口是被托盘拉起来的 → 那一刻渲染层还不存在，push 会丢，主进程先暂存，
 *   这里启动时用 takeTrayCommand 主动取一次。
 *
 * 必须在 registerDefaultCommands() 之后调用，否则 registry 还是空的。
 */
import type { TrayCommandId } from '@shared/ipc/system'

import { commandRegistry } from './commandRegistry'

function runTrayCommand(id: TrayCommandId): void {
  const command = commandRegistry.getAll().find((c) => c.id === id)
  if (!command) {
    console.warn('[tray] unknown command:', id)
    return
  }
  void command.action()
}

export async function setupTrayCommands(): Promise<void> {
  window.api.system.onTrayCommand(({ command }) => runTrayCommand(command))

  const pending = await window.api.system.takeTrayCommand()
  if (pending) runTrayCommand(pending)
}
