import { randomUUID } from '@renderer/lib/utils'
import type {
  ContextBlock,
  NormalizedMessage,
  TokenUsage,
  TurnEvent,
  ApprovalRequest,
} from '@shared/backend/types'
import { defineStore } from 'pinia'
import { ref } from 'vue'

interface PendingApproval {
  requestId: string
  request: ApprovalRequest
  turnId: string
}

export const useMessageStore = defineStore('message', () => {
  const messages = ref<NormalizedMessage[]>([])
  const currentTurnId = ref<string | null>(null)
  const isRunning = ref(false)
  const pendingApproval = ref<PendingApproval | null>(null)
  const lastError = ref<string | null>(null)
  const lastUsage = ref<TokenUsage | null>(null)
  const loading = ref(false)

  /** 把 TurnEvent 累积成 NormalizedMessage[] */
  function applyEvent(event: TurnEvent): void {
    switch (event.type) {
      case 'turn_started': {
        currentTurnId.value = event.turnId
        isRunning.value = true
        lastError.value = null
        break
      }
      case 'text_delta': {
        const msg = findOrCreateAssistantMessage(event.turnId, event.itemId)
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
        const msg = findOrCreateAssistantMessage(event.turnId, event.itemId)
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
        const msg = findOrCreateAssistantMessage(event.turnId, event.itemId)
        if (!msg.toolBlocks) msg.toolBlocks = []
        msg.toolBlocks.push({
          id: event.itemId,
          info: event.tool,
          status: 'running',
        })
        break
      }
      case 'tool_call_completed': {
        const msg = findMessageByItemId(event.turnId, event.itemId)
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
        pendingApproval.value = {
          requestId: event.requestId,
          request: event.request,
          turnId: event.turnId,
        }
        break
      }
      case 'error': {
        lastError.value = event.message
        if (!event.recoverable) {
          isRunning.value = false
        }
        break
      }
      case 'turn_completed': {
        isRunning.value = false
        currentTurnId.value = null
        if (event.usage) {
          lastUsage.value = event.usage
        }
        break
      }
    }
  }

  function findOrCreateAssistantMessage(turnId: string, itemId: string): NormalizedMessage {
    // 先找已有的同 itemId 的 message
    let msg = findMessageByItemId(turnId, itemId)
    if (msg) return msg

    // 否则创建新的 assistant message
    msg = {
      id: itemId,
      role: 'assistant',
      turnId,
      createdAt: Date.now(),
    }
    messages.value.push(msg)
    return msg
  }

  function findMessageByItemId(turnId: string, itemId: string): NormalizedMessage | undefined {
    return messages.value.find((m) => m.turnId === turnId && m.id === itemId)
  }

  /** 加一条用户消息（在发 turn 之前）
   *  contextBlocks 可选——如果传入，UI 会把对应 tag 渲染成专门的卡片
   *  （IDE selection / opened file / environment_context 等），跟气泡平级展示。 */
  function pushUserMessage(
    turnId: string,
    text: string,
    contextBlocks?: ContextBlock[],
  ): void {
    messages.value.push({
      id: randomUUID(),
      role: 'user',
      turnId,
      textBlocks: [{ id: randomUUID(), text, kind: 'text' }],
      ...(contextBlocks && contextBlocks.length > 0 ? { contextBlocks } : {}),
      createdAt: Date.now(),
    })
  }

  function reset(): void {
    messages.value = []
    currentTurnId.value = null
    isRunning.value = false
    pendingApproval.value = null
    lastError.value = null
    lastUsage.value = null
  }

  function setMessages(newMessages: NormalizedMessage[]): void {
    messages.value = newMessages
  }

  function setLoading(v: boolean): void {
    loading.value = v
  }

  function setError(msg: string | null): void {
    lastError.value = msg
  }

  return {
    messages,
    currentTurnId,
    isRunning,
    pendingApproval,
    lastError,
    lastUsage,
    loading,
    applyEvent,
    pushUserMessage,
    reset,
    setMessages,
    setLoading,
    setError,
  }
})
