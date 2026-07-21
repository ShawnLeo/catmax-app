/**
 * ApprovalBridge —— per-turn Unix Domain Socket server。
 *
 * 职责：
 * - 监听 socketPath，等 MCP server 子进程连进来
 * - 验证 token（spawn MCP server 时通过 env 传给它的）
 * - 把 MCP server 转发上来的 permission_request 通过 onRequest 回调交给 ClaudeAdapter
 * - ClaudeAdapter 收到用户决策后调 respond()，把决策写回 socket → MCP server → claude
 *
 * 生命周期：跟一个 claude turn 绑定。ClaudeAdapter.startTurn 创建、finally 销毁。
 *
 * 设计要点：
 * - 同时只允许一个连接（per-turn 一个 MCP server 子进程）
 * - 第一条消息必须是 auth，token 不匹配立刻 close（防止外部进程乱连）
 * - 解析用 newline-delimited JSON（socket 数据量小，简单实现够用）
 */
import { unlink } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'

import { logger } from '@main/service/logger'

import {
  decodeBridgeMessages,
  encodeBridgeMessage,
  type BridgeMessage,
  type PermissionRequestMessage,
} from './mcp/protocol'

const log = logger.domain('claude-approval-bridge')

/** MCP server 转发上来的权限请求（已脱协议） */
export interface BridgePermissionRequest {
  requestId: number
  toolName: string
  input: Record<string, unknown>
}

export interface ApprovalBridgeOptions {
  socketPath: string
  /** 鉴权 token——spawn MCP server 时通过 env 传给它，第一条消息必须匹配 */
  token: string
  turnId: string
  /** 收到权限请求时触发（同步调，由 adapter 异步处理） */
  onRequest: (req: BridgePermissionRequest) => void
  /** MCP server 断开连接时触发（adapter 用来清理 pendingApprovals） */
  onDisconnect?: () => void
}

export class ApprovalBridge {
  private server: Server | null = null
  private socket: Socket | null = null
  private buffer = ''
  private authenticated = false

  constructor(private opts: ApprovalBridgeOptions) {}

  /** 启动 socket server——阻塞到 listen 成功 */
  async start(): Promise<void> {
    this.server = createServer((sock) => this.handleConnection(sock))
    // 监听前先清残留 socket 文件（上次 main 崩溃可能留下）
    try {
      await unlink(this.opts.socketPath)
    } catch {
      // 不存在就忽略
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error): void => {
        reject(e)
      }
      this.server!.once('error', onError)
      this.server!.listen(this.opts.socketPath, () => {
        this.server!.removeListener('error', onError)
        log.info('listening on', this.opts.socketPath, 'turn=', this.opts.turnId)
        resolve()
      })
    })
  }

  /** 关闭——turn 结束 / interrupt 时调 */
  async stop(): Promise<void> {
    this.socket?.destroy()
    this.socket = null
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve())
      })
      this.server = null
    }
    // 清 socket 文件
    try {
      await unlink(this.opts.socketPath)
    } catch {
      // 忽略
    }
    log.info('stopped, turn=', this.opts.turnId)
  }

  /** 用户决策后写回 socket → MCP server → claude */
  respond(
    requestId: number,
    behavior: 'allow' | 'deny',
    originalInput: Record<string, unknown>,
    message?: string,
  ): void {
    const msg: BridgeMessage =
      behavior === 'allow'
        ? { type: 'permission_response', requestId, behavior: 'allow', updatedInput: originalInput }
        : {
            type: 'permission_response',
            requestId,
            behavior: 'deny',
            message: message ?? '用户拒绝',
          }
    if (!this.socket || this.socket.destroyed) {
      log.warn('respond called but socket gone, requestId=', requestId)
      return
    }
    this.socket.write(encodeBridgeMessage(msg))
  }

  private handleConnection(sock: Socket): void {
    if (this.socket) {
      // 同时只允许一个连接——防止 race（不太会发生，但兜底）
      log.warn('multiple connections attempted, rejecting')
      sock.destroy()
      return
    }
    this.socket = sock
    this.authenticated = false
    this.buffer = ''
    log.info('mcp server connected, waiting for auth')

    sock.on('data', (chunk) => {
      this.buffer += chunk.toString()
      const { messages, remaining } = decodeBridgeMessages(this.buffer)
      this.buffer = remaining
      for (const msg of messages) {
        this.handleMessage(msg)
      }
    })

    sock.on('close', () => {
      log.info('mcp server disconnected, turn=', this.opts.turnId)
      this.socket = null
      this.authenticated = false
      this.opts.onDisconnect?.()
    })

    sock.on('error', (e) => {
      // socket 错误大部分是 close 的前置，不重复打日志
      log.warn('socket error:', e.message)
    })
  }

  private handleMessage(msg: BridgeMessage): void {
    if (!this.authenticated) {
      if (msg.type === 'auth' && msg.token === this.opts.token) {
        this.authenticated = true
        log.info('authenticated, turn=', this.opts.turnId)
      } else {
        log.warn('auth failed or first message not auth, closing socket')
        this.socket?.destroy()
      }
      return
    }
    if (msg.type === 'permission_request') {
      this.handlePermissionRequest(msg)
    }
    // permission_response 是 bridge 发出的，不会收到
    // auth 重复也忽略
  }

  private handlePermissionRequest(msg: PermissionRequestMessage): void {
    this.opts.onRequest({
      requestId: msg.requestId,
      toolName: msg.tool_name,
      input: msg.input,
    })
  }
}
