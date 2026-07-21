import { randomUUID } from '@renderer/lib/utils'
import type {
  ContextBlock,
  NormalizedMessage,
  TokenUsage,
  TurnEvent,
  ApprovalRequest,
  ToolControlQuestion,
} from '@shared/backend/types'
import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'

interface PendingApproval {
  requestId: string
  request: ApprovalRequest
  turnId: string
}

interface PendingQuestion {
  requestId: string
  toolUseId: string
  turnId: string
  questions: ToolControlQuestion[]
}

/**
 * 单个 session 的所有 message 相关状态。
 *
 * 改造历史：原本 messageStore 是全局单值，切 session 时 reset 清空。
 * 但 claude 多 turn 并发场景下，用户切走时 A 的 turn 可能还在跑（权限请求 / 流式输出），
 * 这时 A 的状态被清空 → 切回 A 看不到正在跑的 turn，dialog 消失但 main 进程还在等回应。
 *
 * 现在按 sessionId 各持一份状态，切 session 只是切 currentSessionId，不动各 session 的内容。
 */
interface SessionState {
  messages: NormalizedMessage[]
  currentTurnId: string | null
  isRunning: boolean
  /** codex approval 请求 */
  pendingApproval: PendingApproval | null
  /** claude 通过内置 MCP server 的权限请求（走 ClaudePermissionDialog） */
  pendingClaudePermission: PendingApproval | null
  /** claude AskUserQuestion（走 AskUserQuestionDialog） */
  pendingQuestion: PendingQuestion | null
  lastError: string | null
  lastUsage: TokenUsage | null
}

function createEmptySessionState(): SessionState {
  return {
    messages: [],
    currentTurnId: null,
    isRunning: false,
    pendingApproval: null,
    pendingClaudePermission: null,
    pendingQuestion: null,
    lastError: null,
    lastUsage: null,
  }
}

export const useMessageStore = defineStore('message', () => {
  /** sessionId → 该 session 的状态。用 reactive Map 让 Vue 跟踪 set/get */
  const sessionStates = reactive(new Map<string, SessionState>())
  /** 当前激活的 session——所有非 session 限定的访问（messages/pending* 等）都从这个 session 取 */
  const currentSessionId = ref<string | null>(null)

  /** loading 是全局的（loadHistory 跨 session） */
  const loading = ref(false)
  /** 全局 error——不跟 session 绑定，给 loadHistory 等全局错误用 */
  const globalError = ref<string | null>(null)

  /** 取当前 session 状态——没有就懒创建一个空状态 */
  function cur(): SessionState {
    const id = currentSessionId.value
    if (!id) {
      // 没设当前 session 时返回一个共享的空 state（让 computed 不报错）
      return EMPTY_STATE
    }
    let s = sessionStates.get(id)
    if (!s) {
      s = createEmptySessionState()
      sessionStates.set(id, s)
    }
    return s
  }

  // 共享的空 state——currentSessionId 为 null 时用。
  // 注意：写它的字段没意义（写完就丢），只用于读
  const EMPTY_STATE = createEmptySessionState()

  // ============ 对外暴露的状态（computed + setter，保持调用方兼容） ============
  // computed 让外部访问 messageStore.messages 时 reactive；setter 让 `store.xxx = ...` 也能工作。

  const messages = computed({
    get: () => cur().messages,
    set: (v: NormalizedMessage[]) => {
      const id = currentSessionId.value
      if (!id) return
      const s = sessionStates.get(id) ?? createEmptySessionState()
      s.messages = v
      sessionStates.set(id, s)
    },
  })

  const currentTurnId = computed(() => cur().currentTurnId)

  const isRunning = computed(() => cur().isRunning)

  const pendingApproval = computed({
    get: () => cur().pendingApproval,
    set: (v: PendingApproval | null) => {
      const id = currentSessionId.value
      if (!id) return
      const s = cur()
      s.pendingApproval = v
    },
  })

  const pendingClaudePermission = computed({
    get: () => cur().pendingClaudePermission,
    set: (v: PendingApproval | null) => {
      const id = currentSessionId.value
      if (!id) return
      const s = cur()
      s.pendingClaudePermission = v
    },
  })

  const pendingQuestion = computed({
    get: () => cur().pendingQuestion,
    set: (v: PendingQuestion | null) => {
      const id = currentSessionId.value
      if (!id) return
      const s = cur()
      s.pendingQuestion = v
    },
  })

  const lastError = computed(() => cur().lastError)
  const lastUsage = computed(() => cur().lastUsage)

  /** 把 TurnEvent 累积到对应 session 的 NormalizedMessage[]。
   *  sessionId 由 backend envelope 提供（多 turn 并发隔离）。 */
  function applyEvent(sessionId: string, event: TurnEvent): void {
    let s = sessionStates.get(sessionId)
    if (!s) {
      s = createEmptySessionState()
      sessionStates.set(sessionId, s)
    }
    applyEventToState(s, event)
  }

  function applyEventToState(s: SessionState, event: TurnEvent): void {
    switch (event.type) {
      case 'turn_started': {
        s.currentTurnId = event.turnId
        s.isRunning = true
        s.lastError = null
        break
      }
      case 'text_delta': {
        const msg = findOrCreateAssistantMessage(s, event.turnId, event.itemId)
        if (!msg.textBlocks) msg.textBlocks = []
        const lastBlock = msg.textBlocks[msg.textBlocks.length - 1]
        if (lastBlock && lastBlock.id === `${event.itemId}-text`) {
          lastBlock.text += event.text
        } else {
          msg.textBlocks.push({
            id: `${event.itemId}-text`,
            text: event.text,
            kind: 'text',
          })
        }
        break
      }
      case 'reasoning_delta': {
        const msg = findOrCreateAssistantMessage(s, event.turnId, event.itemId)
        if (!msg.textBlocks) msg.textBlocks = []
        // Bug G：reasoning_delta 必须和 text_delta 一样按 itemId 累积到同一个 block，
        // 否则每个 token delta 都被 push 成独立 block（UI 上显示成 46 个 span）。
        const lastBlock = msg.textBlocks[msg.textBlocks.length - 1]
        if (lastBlock && lastBlock.id === `${event.itemId}-reasoning`) {
          lastBlock.text += event.text
        } else {
          msg.textBlocks.push({
            id: `${event.itemId}-reasoning`,
            text: event.text,
            kind: 'reasoning',
          })
        }
        break
      }
      case 'tool_call_started': {
        const msg = findOrCreateAssistantMessage(s, event.turnId, event.itemId)
        if (!msg.toolBlocks) msg.toolBlocks = []
        msg.toolBlocks.push({
          id: event.itemId,
          info: event.tool,
          status: 'running',
        })
        break
      }
      case 'tool_call_completed': {
        const msg = findMessageByItemId(s, event.turnId, event.itemId)
        if (msg?.toolBlocks) {
          const block = msg.toolBlocks.find((b) => b.id === event.itemId)
          if (block) {
            block.status = event.output.ok ? 'completed' : 'failed'
            block.output = event.output
          }
        }
        break
      }
      case 'approval_requested': {
        // 按 source 分发——claude 走 pendingClaudePermission（ClaudePermissionDialog），
        // codex（不带 source）走 pendingApproval（ApprovalDialog）。
        const target = event.source === 'claude' ? 'pendingClaudePermission' : 'pendingApproval'
        s[target] = {
          requestId: event.requestId,
          request: event.request,
          turnId: event.turnId,
        }
        break
      }
      case 'ask_user_question': {
        s.pendingQuestion = {
          requestId: event.requestId,
          toolUseId: event.toolUseId,
          turnId: event.turnId,
          questions: event.questions,
        }
        break
      }
      case 'error': {
        s.lastError = event.message
        if (!event.recoverable) {
          s.isRunning = false
        }
        break
      }
      case 'turn_completed': {
        s.isRunning = false
        s.currentTurnId = null
        if (event.usage) {
          s.lastUsage = event.usage
        }
        // turn 结束时兜底清空 pending——
        // 正常流程下 dialog 提交/cancel 时 ChatView 已经清了，
        // 这里防止 dialog 卡住（比如 turn 因各种原因提前结束时）。
        s.pendingQuestion = null
        s.pendingClaudePermission = null
        break
      }
    }
  }

  function findOrCreateAssistantMessage(
    s: SessionState,
    turnId: string,
    itemId: string,
  ): NormalizedMessage {
    // 先找已有的同 itemId 的 message
    let msg = findMessageByItemId(s, turnId, itemId)
    if (msg) return msg

    // 否则创建新的 assistant message
    msg = {
      id: itemId,
      role: 'assistant',
      turnId,
      createdAt: Date.now(),
    }
    s.messages.push(msg)
    return msg
  }

  function findMessageByItemId(
    s: SessionState,
    turnId: string,
    itemId: string,
  ): NormalizedMessage | undefined {
    return s.messages.find((m) => m.turnId === turnId && m.id === itemId)
  }

  /** 加一条用户消息到当前 session（在发 turn 之前）。
   *  contextBlocks 可选——如果传入，UI 会把对应 tag 渲染成专门的卡片
   *  （IDE selection / opened file / environment_context 等），跟气泡平级展示。 */
  function pushUserMessage(turnId: string, text: string, contextBlocks?: ContextBlock[]): void {
    if (!currentSessionId.value) return
    const s = cur()
    s.messages.push({
      id: randomUUID(),
      role: 'user',
      turnId,
      textBlocks: [{ id: randomUUID(), text, kind: 'text' }],
      ...(contextBlocks && contextBlocks.length > 0 ? { contextBlocks } : {}),
      createdAt: Date.now(),
    })
  }

  /**
   * 切换当前 session——不动各 session 的状态（多 turn 并发时不互相清空）。
   * 旧版 reset() 行为已废弃——切 session 不应该清掉后台还在跑的 turn 状态。
   *
   * 空字符串当 null 处理——sessionStore.setCurrent('') 表示"没选 session"
   * （新建会话场景），跟 null 语义一致。
   */
  function setCurrentSession(sessionId: string | null): void {
    currentSessionId.value = sessionId === '' ? null : sessionId
  }

  /**
   * 替换当前 session 的 messages（loadHistory 调）。
   * 不动其他 session 状态。
   */
  function setMessages(newMessages: NormalizedMessage[]): void {
    if (!currentSessionId.value) return
    const s = cur()
    s.messages = newMessages
  }

  /** 显式清空某个 session 的状态——删除 session 时调 */
  function clearSession(sessionId: string): void {
    sessionStates.delete(sessionId)
  }

  /**
   * 重置所有 session 状态——切工作区 / 切 backend 时调（彻底清空）。
   * 不同于旧版 reset()——旧版只清"当前 session"，现在清所有 session。
   */
  function resetAll(): void {
    sessionStates.clear()
    currentSessionId.value = null
    globalError.value = null
  }

  function setLoading(v: boolean): void {
    loading.value = v
  }

  function setError(msg: string | null): void {
    if (!currentSessionId.value) {
      globalError.value = msg
      return
    }
    // 写到当前 session——ChatView 渲染 lastError 时能正确读到
    const s = cur()
    s.lastError = msg
  }

  return {
    // 状态（computed + setter，调用方原代码不动）
    messages,
    currentTurnId,
    isRunning,
    pendingApproval,
    pendingClaudePermission,
    pendingQuestion,
    lastError,
    lastUsage,
    loading,
    // session 管理
    currentSessionId,
    sessionStates,
    // 方法
    applyEvent,
    pushUserMessage,
    setCurrentSession,
    setMessages,
    clearSession,
    resetAll,
    setLoading,
    setError,
  }
})
