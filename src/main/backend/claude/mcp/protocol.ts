/**
 * ApprovalBridge ↔ MCP server 之间的 socket 协议。
 *
 * 通道：Unix Domain Socket（per-turn 一个，路径 <userData>/catmax-claude-<turnId>.sock）
 * 帧格式：newline-delimited JSON（每条消息一行）
 *
 * 消息流向：
 *   1. MCP server 启动 → connect(socketPath) → 发 auth
 *   2. bridge 验证 token → 通过后接受后续消息
 *   3. claude 调 approve tool → MCP server 发 permission_request
 *   4. bridge 转给 ClaudeAdapter → 推 TurnEvent → renderer 弹 dialog
 *   5. 用户决策 → IPC → ClaudeAdapter → bridge 发 permission_response
 *   6. MCP server 收到 → 解 promise → 返回 MCP tool result 给 claude
 */

/** MCP server → bridge：建立连接后第一条消息 */
export interface AuthMessage {
  type: 'auth'
  token: string
}

/** MCP server → bridge：claude 调 approve tool，请求权限 */
export interface PermissionRequestMessage {
  type: 'permission_request'
  /** MCP server 内部递增的 id，response 必须带同样的 id 配对 */
  requestId: number
  /** 被拦截的工具名，如 "Bash" / "Write" / "mcp__xxx__yyy" */
  tool_name: string
  /** 工具的原始入参 */
  input: Record<string, unknown>
}

/** bridge → MCP server：用户的决策结果 */
export interface PermissionResponseMessage {
  type: 'permission_response'
  requestId: number
  /**
   * 'allow' = 允许执行；'deny' = 拒绝
   * claude 的 permission-prompt-tool 协议规定：
   *   - allow 必须带 updatedInput（原样回传 input）
   *   - deny 必须带 message（claude 会看到这个原因）
   */
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  message?: string
}

export type BridgeMessage = AuthMessage | PermissionRequestMessage | PermissionResponseMessage

/** 编码：消息 → 一行 JSON 字符串（带 \n） */
export function encodeBridgeMessage(msg: BridgeMessage): string {
  return JSON.stringify(msg) + '\n'
}

/**
 * 解码：从累积的 buffer 里切出完整行，返回 [messages, remaining]。
 * 简单实现——socket 数据量小（每条权限请求/响应都是几百字节），
 * 不需要复杂的状态机。
 */
export function decodeBridgeMessages(buffer: string): {
  messages: BridgeMessage[]
  remaining: string
} {
  const messages: BridgeMessage[] = []
  let remaining = buffer
  // eslint-disable-next-line no-constant-condition -- 切行循环，break 在内部
  while (true) {
    const idx = remaining.indexOf('\n')
    if (idx < 0) break
    const line = remaining.slice(0, idx).trim()
    remaining = remaining.slice(idx + 1)
    if (!line) continue
    try {
      messages.push(JSON.parse(line) as BridgeMessage)
    } catch {
      // 畸形 JSON 忽略——单条坏消息不应让整个连接挂掉
    }
  }
  return { messages, remaining }
}
