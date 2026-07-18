import type { PtyHandlers } from '@shared/ipc/pty'

import { handleRendererRequest } from '../../typed'

import { createTerminal, killTerminal, resizeTerminal, writeTerminal } from './handlers'

export function registerPtyHandlers(): void {
  handleRendererRequest<PtyHandlers, 'pty.create'>('pty.create', createTerminal)
  handleRendererRequest<PtyHandlers, 'pty.write'>('pty.write', writeTerminal)
  handleRendererRequest<PtyHandlers, 'pty.resize'>('pty.resize', resizeTerminal)
  handleRendererRequest<PtyHandlers, 'pty.kill'>('pty.kill', killTerminal)
}

export type { PtyHandlers } from '@shared/ipc/pty'
