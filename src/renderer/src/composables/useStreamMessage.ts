import { useMessageStore } from '@renderer/stores/message'
import { onMounted, onUnmounted } from 'vue'

/**
 * 订阅 backend:turnEvent，把事件累积到 message store。
 * 在 ChatView onMounted 时开始订阅，onUnmounted 时取消。
 */
export function useStreamMessage() {
  const messageStore = useMessageStore()
  let unsubscribe: (() => void) | null = null

  onMounted(() => {
    unsubscribe = window.api.backend.onTurnEvent(({ event }) => {
      messageStore.applyEvent(event)
    })
  })

  onUnmounted(() => {
    unsubscribe?.()
    unsubscribe = null
  })

  return { messageStore }
}
