import { useMessageStore } from '@renderer/stores/message'
import { onMounted, onUnmounted } from 'vue'

/**
 * 订阅 backend:turnEvent，把事件累积到 message store。
 *
 * envelope 带 sessionId——多 turn 并发时按 sessionId 路由到对应 session 状态，
 * 用户切走 session A 后 A 的 turn 事件继续累积到 A 的状态，切回来能恢复显示。
 */
export function useStreamMessage() {
  const messageStore = useMessageStore()
  let unsubscribe: (() => void) | null = null

  onMounted(() => {
    unsubscribe = window.api.backend.onTurnEvent(({ sessionId, event }) => {
      messageStore.applyEvent(sessionId, event)
    })
  })

  onUnmounted(() => {
    unsubscribe?.()
    unsubscribe = null
  })

  return { messageStore }
}
