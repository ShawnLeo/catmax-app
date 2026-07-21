/**
 * catmax 内置 MCP server——被 claude CLI 通过 --mcp-config spawn 起。
 *
 * 职责：
 * - 实现 `approve` 工具，作为 claude `--permission-prompt-tool` 的目标
 * - claude 调 approve 时把权限请求经 Unix socket 转给 catmax main 的 ApprovalBridge
 * - main 弹 UI 让用户决策 → 写回 socket → 我们 return 给 claude
 *
 * ===== 重要约束 =====
 * 这个文件被 electron-vite 打成独立 chunk（out/main/mcp-server.js），
 * spawn 时带 ELECTRON_RUN_AS_NODE=1（Electron 当 Node 用），所以：
 *   - 禁止 import 'electron'（spawn 时没有 Electron runtime）
 *   - 禁止 import '@main/...'（避免拉 main 进程代码进 bundle）
 *   - 只能 import @shared/* 的纯类型 + node: 内置模块 + dependencies
 */
import { createConnection, type Socket } from 'node:net'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  decodeBridgeMessages,
  encodeBridgeMessage,
  type BridgeMessage,
  type PermissionResponseMessage,
} from './protocol'

// ============ env 解析（spawn 时传进来） ============
const SOCKET_PATH = process.env.CATMAX_APPROVAL_SOCKET
const TOKEN = process.env.CATMAX_APPROVAL_TOKEN
if (!SOCKET_PATH || !TOKEN) {
  console.error('[catmax-mcp] missing CATMAX_APPROVAL_SOCKET / CATMAX_APPROVAL_TOKEN env')
  process.exit(1)
}

// ============ 连 ApprovalBridge ============
const sock: Socket = createConnection(SOCKET_PATH)
sock.on('error', (e) => {
  console.error('[catmax-mcp] socket error:', e.message)
})

let buffer = ''
let nextRequestId = 1
const pending = new Map<number, (resp: PermissionResponseMessage) => void>()

// 立刻发 auth（必须在其他消息之前）
sock.write(encodeBridgeMessage({ type: 'auth', token: TOKEN }))

sock.on('data', (chunk) => {
  buffer += chunk.toString()
  const { messages, remaining } = decodeBridgeMessages(buffer)
  buffer = remaining
  for (const msg of messages) {
    handleMessage(msg)
  }
})

sock.on('close', () => {
  console.error('[catmax-mcp] bridge disconnected, exiting')
  // bridge 断开意味着 turn 结束——所有 pending 都失败 resolve（deny）
  for (const [, resolve] of pending) {
    resolve({
      type: 'permission_response',
      requestId: -1,
      behavior: 'deny',
      message: 'bridge disconnected',
    })
  }
  pending.clear()
  process.exit(0)
})

function handleMessage(msg: BridgeMessage): void {
  if (msg.type === 'permission_response') {
    const resolve = pending.get(msg.requestId)
    if (resolve) {
      resolve(msg)
      pending.delete(msg.requestId)
    }
  }
  // 其他消息类型（auth / permission_request）不会从 bridge 收到
}

/** 问 bridge 拿用户决策——promise 在 bridge 写回时 resolve */
function askBridge(
  toolName: string,
  input: Record<string, unknown>,
): Promise<PermissionResponseMessage> {
  return new Promise((resolve) => {
    const requestId = nextRequestId++
    pending.set(requestId, resolve)
    sock.write(
      encodeBridgeMessage({
        type: 'permission_request',
        requestId,
        tool_name: toolName,
        input,
      }),
    )
  })
}

// ============ MCP server 注册 ============
const mcpServer = new McpServer(
  { name: 'catmax', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  },
)

mcpServer.registerTool(
  'approve',
  {
    description: 'Route permission prompts to catmax UI for user decision',
    inputSchema: {
      tool_name: z.string().describe('The tool Claude wants to use (e.g. "Bash", "Write")'),
      input: z.record(z.unknown()).describe('The tool input parameters'),
    },
  },
  async ({ tool_name, input }) => {
    const decision = await askBridge(tool_name, input)
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            behavior: decision.behavior,
            ...(decision.behavior === 'allow'
              ? { updatedInput: decision.updatedInput ?? input }
              : { message: decision.message ?? '用户拒绝' }),
          }),
        },
      ],
    }
  },
)

// ============ 启动 ============
const transport = new StdioServerTransport()
await mcpServer.connect(transport)
console.error('[catmax-mcp] server ready') // stderr，不污染 stdio（stdout 是 MCP 协议）

// 持续运行，直到 stdin 关闭（claude 退出）或 bridge 断开
// Node 进程会自然挂在 transport 上，不需要 keepalive
