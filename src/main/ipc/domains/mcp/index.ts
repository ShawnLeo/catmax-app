import type { McpHandlers } from '@shared/ipc/mcp'

import { handleRendererRequest } from '../../typed'

import {
  listMcpServers,
  refreshMcpRuntime,
  removeMcpServer,
  revealMcpConfig,
  setMcpEnabled,
  syncMcpOnStartupHandler,
  syncMcpServer,
  trustCodexProject,
  unsyncMcpServer,
} from './handlers'

export function registerMcpHandlers(): void {
  handleRendererRequest<McpHandlers, 'mcp.list'>('mcp.list', listMcpServers)
  handleRendererRequest<McpHandlers, 'mcp.reveal'>('mcp.reveal', revealMcpConfig)
  handleRendererRequest<McpHandlers, 'mcp.refreshRuntime'>('mcp.refreshRuntime', refreshMcpRuntime)
  handleRendererRequest<McpHandlers, 'mcp.setEnabled'>('mcp.setEnabled', setMcpEnabled)
  handleRendererRequest<McpHandlers, 'mcp.trustProject'>('mcp.trustProject', trustCodexProject)
  handleRendererRequest<McpHandlers, 'mcp.sync'>('mcp.sync', syncMcpServer)
  handleRendererRequest<McpHandlers, 'mcp.unsync'>('mcp.unsync', unsyncMcpServer)
  handleRendererRequest<McpHandlers, 'mcp.remove'>('mcp.remove', removeMcpServer)
}

export { syncMcpOnStartupHandler }
export type { McpHandlers } from '@shared/ipc/mcp'
