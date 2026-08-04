import { useMessageStore } from '@renderer/stores/message'
import { onMounted, onUnmounted, watch } from 'vue'

/**
 * 按需用后端权威的 turn 状态对齐内存里的 isRunning。
 *
 * 为什么需要它：isRunning 是纯内存标志，正常只靠 backend:turnEvent 流转为 false。
 * 但 HMR 热更新 / 切窗口 / 视图重挂会让 useStreamMessage 的 onTurnEvent 订阅出现真空
 * 窗口（onUnmounted 已拆、onMounted 未建），若 turn 恰好在窗口内结束，turn_completed
 * 被静默丢弃，isRunning 永远卡在 true——spinner 永转、"正在思考"永驻。
 *
 * 这条 composable 在三个时机拉一次 listTurnRuns 纠正卡死状态：
 *   1. ChatView 挂载（含 HMR 重挂）
 *   2. 切回某个 session（currentSessionId 变化）
 *   3. 窗口重新聚焦 / 页面重新可见
 *
 * 只查当前 session、且仅当内存以为还在跑时才打扰后端，开销可忽略。
 */
export function useTurnRunReconcile(): void {
  const messageStore = useMessageStore()

  async function reconcileCurrentSession(reason: string): Promise<void> {
    const sessionId = messageStore.currentSessionId
    if (!sessionId) return
    // 本来就没在跑——无需打扰后端，也避免无谓 IPC。
    const s = messageStore.sessionStates.get(sessionId)
    if (!s?.isRunning) return
    try {
      const runs = await window.api.backend.listTurnRuns({ sessionId })
      // createdAt DESC——同 session 串行排队，至多一条活跃，取最近一条代表当前 turn。
      void messageStore.reconcileTurnRun(sessionId, runs[0])
    } catch (e) {
      console.warn(`[TurnRunReconcile] ${reason} reconcile failed:`, e)
    }
  }

  // 时机 3: 窗口重新聚焦（从别的应用/窗口切回来）
  const onFocus = (): void => {
    void reconcileCurrentSession('window-focus')
  }
  // 时机 3: 页面重新可见（切回应用 tab / 从睡眠唤醒）
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') void reconcileCurrentSession('visibility')
  }

  onMounted(() => {
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    // 时机 1: ChatView 挂载（含 HMR 重挂）——立即对齐一次。
    void reconcileCurrentSession('mount')
  })
  onUnmounted(() => {
    window.removeEventListener('focus', onFocus)
    document.removeEventListener('visibilitychange', onVisibility)
  })

  // 时机 2: 切 session（currentSessionId 变化）——切回来时对齐。
  // 用 watch 而非改 setCurrentSession：session.ts ↔ message.ts 已有循环依赖风险
  // （session.ts 用动态 import 拿 messageStore），composable 层无此问题。
  const stopWatch = watch(
    () => messageStore.currentSessionId,
    (newId) => {
      if (newId) void reconcileCurrentSession('session-switch')
    },
  )
  onUnmounted(() => stopWatch())
}
