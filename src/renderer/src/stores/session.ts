import { toPlainWorkspaceFolders } from '@renderer/lib/workspace-folder-context'
import type { EffortLevel, PermissionMode, WorkspaceFolderContext } from '@shared/backend/types'
import { type BackendId } from '@shared/constants'
import type { SessionView } from '@shared/domain'
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useSessionStore = defineStore('session', () => {
  const sessions = ref<SessionView[]>([])
  const currentSessionId = ref<string | null>(null)
  /**
   * 每次用户/程序切换会话都会递增。
   * 首条消息创建 session 是异步的；完成时用版本号判断用户是否已经点了“新建会话”
   * 或切到别处，避免旧请求把当前页面强行切回去。
   */
  const selectionVersion = ref(0)
  const loading = ref(false)

  const currentSession = computed(() => sessions.value.find((s) => s.id === currentSessionId.value))

  async function load(workspaceId: string, backend: BackendId): Promise<void> {
    loading.value = true
    try {
      const nextSessions = await window.api.session.list({ workspaceId, backend })
      sessions.value = nextSessions

      // Session Selection Consistency: 切后端、切工作区或刷新列表后，旧选择可能不属于
      // 新列表。sessionStore 和 messageStore 分别持有当前 id，必须同时清空；否则侧栏已经
      // 展示新后端的数据，聊天正文仍会渲染旧后端会话的缓存消息。
      if (
        currentSessionId.value !== null &&
        !nextSessions.some((session) => session.id === currentSessionId.value)
      ) {
        currentSessionId.value = null
        selectionVersion.value++
        const { useMessageStore } = await import('@renderer/stores/message')
        useMessageStore().setCurrentSession(null)
      }
    } finally {
      loading.value = false
    }
  }

  /**
   * 与后端对账（启动时、切工作区时、切后端时调）。
   * backend 决定对账完 reload 列表时按哪个 backend 过滤。
   */
  async function reconcile(workspaceId: string, backend: BackendId): Promise<void> {
    const { added, removed, titleBackfilled } = await window.api.session.reconcile({ workspaceId })
    // titleBackfilled 改的是已在列表里的会话——不 reload 的话补上的标题看不见
    if (added.length > 0 || removed.length > 0 || titleBackfilled > 0) {
      await load(workspaceId, backend)
    }
  }

  async function create(args: {
    workspaceId: string
    cwd: string
    workspaceFolders?: WorkspaceFolderContext[]
    backend?: BackendId
    model?: string
    effort?: EffortLevel
    permissionMode?: PermissionMode
    initialPrompt?: string
  }): Promise<string> {
    const plainArgs = {
      ...args,
      ...(args.workspaceFolders !== undefined && {
        workspaceFolders: toPlainWorkspaceFolders(args.workspaceFolders),
      }),
    }
    const { sessionId } = await window.api.session.create(plainArgs)
    // 创建后按 create 的 backend reload——若 args.backend 未传，main 会用当前 backend，
    // 这里与 main 保持一致：用传入的 backend，否则 fallback 到当前 backend id。
    const backend = args.backend ?? (await window.api.backend.current()).id
    await load(args.workspaceId, backend)
    return sessionId
  }

  async function remove(sessionId: string): Promise<void> {
    await window.api.session.remove({ sessionId })
    sessions.value = sessions.value.filter((s) => s.id !== sessionId)
    if (currentSessionId.value === sessionId) {
      currentSessionId.value = null
      selectionVersion.value++
    }
  }

  /**
   * Session Pin: 置顶 / 取消置顶。
   *
   * 置顶改变的是排序，不只是那一行的样子，所以就地改完还要重排——
   * 排序规则跟 main 的 SESSION_ORDER_BY 保持一致（置顶优先，组内按时间倒序）。
   * 重排而不是重 load：避免整列表闪一下，也省一次 IPC。
   */
  async function setPinned(sessionId: string, pinned: boolean): Promise<void> {
    const updated = await window.api.session.setPinned({ sessionId, pinned })
    const index = sessions.value.findIndex((s) => s.id === sessionId)
    if (index !== -1) sessions.value[index] = updated
    sessions.value.sort((a, b) => {
      if (a.pinnedAt !== null && b.pinnedAt !== null) return b.pinnedAt - a.pinnedAt
      if (a.pinnedAt !== null) return -1
      if (b.pinnedAt !== null) return 1
      return b.lastActiveAt - a.lastActiveAt
    })
  }

  /** Session Rename: 重命名会话，就地替换列表里那一行（标题不影响排序）。 */
  async function rename(sessionId: string, title: string): Promise<void> {
    const updated = await window.api.session.rename({ sessionId, title })
    const index = sessions.value.findIndex((s) => s.id === sessionId)
    if (index !== -1) sessions.value[index] = updated
  }

  /**
   * Session Fork: 复制会话。返回新会话 id，调用方决定要不要跳过去。
   *
   * 复制后必须重 load：新会话是 main 侧 insert 的，本地列表里没有它。
   */
  async function fork(sessionId: string, workspaceId: string, backend: BackendId): Promise<string> {
    const result = await window.api.session.fork({ sessionId })
    await load(workspaceId, backend)
    return result.sessionId
  }

  function setCurrent(sessionId: string): void {
    // 空字符串是现有调用方表示“新建会话 / 未选中会话”的哨兵值。
    // 统一归一化为 null，避免 create() 内部 load() 把 '' 误判成已丢失的旧选择，
    // 导致 selectionVersion 再次递增并阻止首条消息自动进入新建会话。
    currentSessionId.value = sessionId === '' ? null : sessionId
    selectionVersion.value++
  }

  async function loadHistory(sessionId: string): Promise<void> {
    const { useMessageStore } = await import('@renderer/stores/message')
    const messageStore = useMessageStore()
    // 新建 session 的首条 turn 可能仍在 Codex 全局 lane 中排队，此时 backend thread
    // 已有 id 但尚未生成 rollout。内存里已经有乐观 user 消息和后续实时事件，
    // 直接复用；否则 thread/read 的空结果会覆盖页面，造成切换时数据消失/乱串。
    if (messageStore.hasLocalMessages(sessionId)) return
    messageStore.setLoading(true)
    try {
      const detail = await window.api.session.detail({ sessionId })
      // 必须写回请求发起时的 session；用户可能在 await 期间已切到另一个会话。
      messageStore.setMessagesForSession(sessionId, detail.messages)

      // 后端给了 aiTitle 且 db 里之前没有标题时，main handler 已经回写 db。
      // 这里同步更新本地 sessions 数组里的 title，让侧边栏立即显示新标题。
      if (detail.aiTitle) {
        const target = sessions.value.find((s) => s.id === sessionId)
        if (target && target.title !== detail.aiTitle) {
          target.title = detail.aiTitle
        }
      }
    } catch (e) {
      messageStore.setErrorForSession(sessionId, e instanceof Error ? e.message : String(e))
    } finally {
      messageStore.setLoading(false)
    }
  }

  return {
    sessions,
    currentSessionId,
    selectionVersion,
    loading,
    currentSession,
    load,
    reconcile,
    create,
    remove,
    setPinned,
    rename,
    fork,
    setCurrent,
    loadHistory,
  }
})
